(function () {
  'use strict';

  if (typeof Chart !== 'undefined' && window.chartjsPluginAnnotation) {
    Chart.register(window.chartjsPluginAnnotation);
  }

  const CHAVE_STORAGE = 'gerenciamento-processos';
  const API_STORAGE_URL = '/.netlify/functions/processos';
  const API_ANEXOS_URL = '/.netlify/functions/anexos';
  const VERSAO_SCHEMA = 2;
  const DEBOUNCE_GRAFICO_MS = 300;
  const INTERVALO_ATUALIZACAO_REMOTA_MS = 15000;

  const AREAS_PREDEFINIDAS = [
    'Compras', 'Financeiro', 'Suporte Shop9', 'TI Projetos', 'Operações', 'RH', 'Jurídico', 'Comercial', 'Qualidade'
  ];

  const STATUS_ETAPA = ['Não iniciado', 'Em andamento', 'Concluído', 'Pausado', 'Cancelado'];
  const STATUS_ETAPA_PADRAO = 'Não iniciado';
  const EXTENSOES_ANEXO_PERMITIDAS = ['pdf', 'xls', 'xlsx', 'ppt', 'pptx'];

  const DADOS_EXEMPLO = {
    processo: { nome: 'Implantação de Sistema', dataGoLive: '2026-03-25' },
    etapas: [
      { id: null, nome: 'Mapeamento de processos', dataInicio: '2026-03-01', dataFim: '2026-03-05', area: 'Qualidade', status: 'Não iniciado' },
      { id: null, nome: 'Aquisição de licenças', dataInicio: '2026-03-05', dataFim: '2026-03-08', area: 'Compras', status: 'Não iniciado' },
      { id: null, nome: 'Instalação do ambiente', dataInicio: '2026-03-10', dataFim: '2026-03-15', area: 'Suporte Shop9', status: 'Não iniciado' },
      { id: null, nome: 'Treinamento dos usuários', dataInicio: '2026-03-18', dataFim: '2026-03-22', area: 'RH', status: 'Não iniciado' },
      { id: null, nome: 'Go-live', dataInicio: '2026-03-25', dataFim: '2026-03-31', area: 'Operações', status: 'Não iniciado' }
    ],
    versao: VERSAO_SCHEMA
  };

  function getDataInicio(etapa) {
    return etapa.dataInicio != null && etapa.dataInicio !== '' ? etapa.dataInicio : (etapa.data || '');
  }

  function getDataFim(etapa) {
    return etapa.dataFim != null && etapa.dataFim !== '' ? etapa.dataFim : (etapa.data || getDataInicio(etapa));
  }

  // --- Estado central (múltiplos processos) ---
  let estado = {
    processos: [],
    processoAtualId: null,
    versao: VERSAO_SCHEMA
  };

  function getProcessoAtual() {
    if (!estado.processos.length) return null;
    if (estado.processoAtualId) {
      const p = estado.processos.find(pr => pr.id === estado.processoAtualId);
      if (p) return p;
    }
    estado.processoAtualId = estado.processos[0].id;
    return estado.processos[0];
  }

  let graficoInstance = null;
  let timeoutGrafico = null;
  let idEtapaEditando = null;
  let etapasVisiveis = true;
  let ultimoPayloadPendente = null;
  let sincronizacaoEmAndamento = false;
  let falhaSincronizacaoNotificada = false;
  let armazenamentoLocalIndisponivel = false;

  // --- Funções puras ---

  function gerarId() {
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
  }

  function formatarDataBR(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const [y, m, d] = iso.split('-');
    if (!d) return iso;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
  }

  function obterExtensaoArquivo(nomeArquivo) {
    if (!nomeArquivo || typeof nomeArquivo !== 'string') return '';
    const partes = nomeArquivo.toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
  }

  function formatarTamanhoArquivo(bytes) {
    const valor = Number(bytes);
    if (!Number.isFinite(valor) || valor <= 0) return '0 B';
    if (valor < 1024) return `${valor} B`;
    if (valor < 1024 * 1024) return `${(valor / 1024).toFixed(1)} KB`;
    return `${(valor / (1024 * 1024)).toFixed(1)} MB`;
  }

  function arquivoPermitido(nomeArquivo) {
    const ext = obterExtensaoArquivo(nomeArquivo);
    return EXTENSOES_ANEXO_PERMITIDAS.includes(ext);
  }

  function lerArquivoComoBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        const separador = dataUrl.indexOf(',');
        if (separador < 0) {
          reject(new Error('Formato de arquivo inválido.'));
          return;
        }
        resolve(dataUrl.slice(separador + 1));
      };
      reader.onerror = () => reject(new Error('Erro ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });
  }

  function construirUrlDownloadAnexo(anexo) {
    if (!anexo || typeof anexo !== 'object') return '#';
    if (typeof anexo.storageKey === 'string' && anexo.storageKey) {
      const nome = typeof anexo.nome === 'string' && anexo.nome ? anexo.nome : 'arquivo';
      return API_ANEXOS_URL + '?key=' + encodeURIComponent(anexo.storageKey) + '&nome=' + encodeURIComponent(nome);
    }
    if (typeof anexo.dataUrl === 'string' && anexo.dataUrl) return anexo.dataUrl;
    return '#';
  }

  function normalizarAnexos(anexos) {
    return (Array.isArray(anexos) ? anexos : [])
      .filter(anexo => anexo && typeof anexo.nome === 'string')
      .filter(anexo =>
        (typeof anexo.storageKey === 'string' && anexo.storageKey) ||
        (typeof anexo.dataUrl === 'string' && anexo.dataUrl)
      )
      .filter(anexo => arquivoPermitido(anexo.nome))
      .map(anexo => ({
        id: anexo.id && typeof anexo.id === 'string' ? anexo.id : gerarId(),
        nome: anexo.nome.trim() || 'arquivo',
        tipo: typeof anexo.tipo === 'string' ? anexo.tipo : '',
        tamanho: Number.isFinite(Number(anexo.tamanho)) ? Number(anexo.tamanho) : 0,
        storageKey: typeof anexo.storageKey === 'string' ? anexo.storageKey : '',
        dataUrl: typeof anexo.dataUrl === 'string' ? anexo.dataUrl : '',
        enviadoEm: typeof anexo.enviadoEm === 'string' ? anexo.enviadoEm : new Date().toISOString()
      }));
  }

  function ordenarEtapasPorData(etapas) {
    return [...etapas].sort((a, b) => getDataInicio(a).localeCompare(getDataInicio(b)));
  }

  function calcularSerieCumulativa(etapas) {
    const ordenadas = ordenarEtapasPorData(etapas);
    if (ordenadas.length === 0) return { labels: [], data: [] };

    const porData = {};
    ordenadas.forEach(e => {
      const d = getDataInicio(e);
      if (!d) return;
      porData[d] = (porData[d] || 0) + 1;
    });
    const datasUnicas = Object.keys(porData).sort();
    const labels = [];
    const data = [];
    let acum = 0;
    datasUnicas.forEach(d => {
      acum += porData[d];
      labels.push(formatarDataBR(d));
      data.push(acum);
    });
    return { labels, data };
  }

  /** Retorna dados para o gráfico com escala de tempo: curva cumulativa, pontos por etapa, e limites do eixo X. */
  function calcularDadosGraficoEvolucao(etapas) {
    const ordenadas = ordenarEtapasPorData(etapas);
    if (ordenadas.length === 0) {
      return { pontosCumulativo: [], pontosEtapas: [], xMin: null, xMax: null, hojeISO: obterHojeISO() };
    }

    const porData = {};
    ordenadas.forEach(e => {
      const d = getDataInicio(e);
      if (!d) return;
      porData[d] = (porData[d] || 0) + 1;
    });
    const datasUnicas = Object.keys(porData).sort();
    const pontosCumulativo = [];
    let acum = 0;
    datasUnicas.forEach(d => {
      acum += porData[d];
      pontosCumulativo.push({ x: d, y: acum });
    });

    const pontosEtapas = [];
    ordenadas.forEach((etapa, idx) => {
      const d = getDataInicio(etapa);
      if (!d) return;
      const cumulativoNaData = pontosCumulativo.find(p => p.x === d)?.y ?? (idx + 1);
      pontosEtapas.push({
        x: d,
        y: cumulativoNaData,
        etapa,
        ordem: idx + 1,
        total: ordenadas.length
      });
    });

    let xMin = datasUnicas[0];
    let xMax = datasUnicas[datasUnicas.length - 1];
    if (datasUnicas.length === 1) {
      const unica = new Date(xMin + 'T12:00:00');
      unica.setDate(unica.getDate() - 1);
      xMin = unica.toISOString().slice(0, 10);
      const unicaMax = new Date(datasUnicas[0] + 'T12:00:00');
      unicaMax.setDate(unicaMax.getDate() + 1);
      xMax = unicaMax.toISOString().slice(0, 10);
    }

    return {
      pontosCumulativo,
      pontosEtapas,
      xMin,
      xMax,
      hojeISO: obterHojeISO()
    };
  }

  function obterHojeISO() {
    const hoje = new Date();
    return hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
  }

  function montarPayload() {
    return {
      processos: estado.processos.map(pr => ({
        id: pr.id,
        nome: pr.nome,
        dataGoLive: pr.dataGoLive || '',
        anexos: (Array.isArray(pr.anexos) ? pr.anexos : []).map(a => ({
          id: a.id,
          nome: a.nome,
          tipo: a.tipo || '',
          tamanho: a.tamanho || 0,
          storageKey: a.storageKey || '',
          dataUrl: a.storageKey ? '' : (a.dataUrl || ''),
          enviadoEm: a.enviadoEm || ''
        })),
        etapas: (Array.isArray(pr.etapas) ? pr.etapas : []).map(e => ({
          id: e.id,
          nome: e.nome,
          dataInicio: getDataInicio(e),
          dataFim: getDataFim(e),
          area: e.area,
          status: STATUS_ETAPA.includes(e.status) ? e.status : STATUS_ETAPA_PADRAO
        }))
      })),
      processoAtualId: estado.processoAtualId,
      versao: estado.versao
    };
  }

  function montarPayloadLocalSemArquivos(payload) {
    return {
      processos: (payload.processos || []).map(pr => ({
        id: pr.id,
        nome: pr.nome,
        dataGoLive: pr.dataGoLive || '',
        anexos: [],
        etapas: pr.etapas || []
      })),
      processoAtualId: payload.processoAtualId,
      versao: payload.versao
    };
  }

  async function salvarRemoto(payload) {
    const resposta = await fetch(API_STORAGE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resposta.ok) {
      throw new Error('Falha ao persistir dados no servidor.');
    }
  }

  async function enviarAnexoRemoto(file, processoId) {
    const conteudoBase64 = await lerArquivoComoBase64(file);
    const resposta = await fetch(API_ANEXOS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processoId: processoId || 'sem-processo',
        nome: file.name,
        tipo: file.type || '',
        conteudoBase64
      })
    });
    if (!resposta.ok) {
      throw new Error('Falha ao enviar anexo para o servidor.');
    }
    return resposta.json();
  }

  async function excluirAnexoRemoto(storageKey) {
    if (!storageKey) return;
    try {
      await fetch(API_ANEXOS_URL + '?key=' + encodeURIComponent(storageKey), { method: 'DELETE' });
    } catch (_) {
      // A remoção remota pode falhar sem bloquear remoção local da lista.
    }
  }

  async function sincronizarPendencias() {
    if (sincronizacaoEmAndamento) return;
    sincronizacaoEmAndamento = true;
    try {
      while (ultimoPayloadPendente) {
        const payload = ultimoPayloadPendente;
        ultimoPayloadPendente = null;
        try {
          await salvarRemoto(payload);
          if (falhaSincronizacaoNotificada) {
            mostrarToast('Sincronização restabelecida.', 'sucesso');
          }
          falhaSincronizacaoNotificada = false;
        } catch (err) {
          ultimoPayloadPendente = payload;
          if (!falhaSincronizacaoNotificada) {
            mostrarToast('Não foi possível sincronizar os dados no servidor.', 'erro');
            falhaSincronizacaoNotificada = true;
          }
          break;
        }
      }
    } finally {
      sincronizacaoEmAndamento = false;
    }
  }

  function salvar() {
    const payload = montarPayload();
    if (!armazenamentoLocalIndisponivel) {
      try {
        const payloadLocal = montarPayloadLocalSemArquivos(payload);
        localStorage.setItem(CHAVE_STORAGE, JSON.stringify(payloadLocal));
      } catch (_) {
        armazenamentoLocalIndisponivel = true;
        mostrarToast('Não foi possível salvar cache local.', 'erro');
      }
    }
    ultimoPayloadPendente = payload;
    sincronizarPendencias();
  }

  function normalizarEtapas(etapas) {
    return (Array.isArray(etapas) ? etapas : [])
      .filter(e => e && typeof e.nome === 'string')
      .map(e => ({
        id: e.id && typeof e.id === 'string' ? e.id : gerarId(),
        nome: e.nome.trim(),
        dataInicio: e.dataInicio != null ? e.dataInicio : (e.data || ''),
        dataFim: e.dataFim != null && e.dataFim !== '' ? e.dataFim : (e.data || (e.dataInicio || '')),
        area: typeof e.area === 'string' ? e.area.trim() : 'Operações',
        status: e.status && STATUS_ETAPA.includes(e.status) ? e.status : STATUS_ETAPA_PADRAO
      }));
  }

  function criarProcesso(opt) {
    const nome = opt && typeof opt.nome === 'string' ? opt.nome : 'Novo processo';
    const dataGoLive = opt && typeof opt.dataGoLive === 'string' ? opt.dataGoLive : '';
    const etapas = opt && Array.isArray(opt.etapas) ? normalizarEtapas(opt.etapas) : [];
    const anexos = opt && Array.isArray(opt.anexos) ? normalizarAnexos(opt.anexos) : [];
    return { id: gerarId(), nome, dataGoLive, anexos, etapas };
  }

  function removerProcessosPadraoNovo() {
    const antes = estado.processos.length;
    estado.processos = estado.processos.filter(pr => {
      const nomePadrao = (pr.nome || '').trim() === 'Novo processo';
      const semConteudo = (!pr.dataGoLive || pr.dataGoLive.trim() === '') && (!Array.isArray(pr.etapas) || pr.etapas.length === 0);
      return !(nomePadrao && semConteudo);
    });
    if (estado.processos.length === 0) return;
    if (!estado.processos.some(p => p.id === estado.processoAtualId)) {
      estado.processoAtualId = estado.processos[0].id;
    }
    if (estado.processos.length !== antes) {
      salvar();
    }
  }

  function aplicarEstadoPersistido(data) {
    if (!data || typeof data !== 'object') throw new Error('Formato inválido.');
    const ver = data.versao == null ? 1 : data.versao;
    if (Array.isArray(data.processos) && data.processos.length > 0) {
      const processos = data.processos.map(pr => ({
        id: pr.id && typeof pr.id === 'string' ? pr.id : gerarId(),
        nome: typeof pr.nome === 'string' ? pr.nome : 'Sem nome',
        dataGoLive: typeof pr.dataGoLive === 'string' ? pr.dataGoLive : '',
        anexos: normalizarAnexos(pr.anexos || []),
        etapas: normalizarEtapas(pr.etapas || [])
      }));
      let processoAtualId = processos[0].id;
      if (data.processoAtualId && processos.some(p => p.id === data.processoAtualId)) processoAtualId = data.processoAtualId;
      estado = { processos, processoAtualId, versao: ver };
      return;
    }
    if (data.processo || data.etapas) {
      const processoUnico = criarProcesso({
        nome: data.processo && typeof data.processo.nome === 'string' ? data.processo.nome : '',
        dataGoLive: data.processo && typeof data.processo.dataGoLive === 'string' ? data.processo.dataGoLive : '',
        anexos: data.processo && Array.isArray(data.processo.anexos) ? data.processo.anexos : [],
        etapas: data.etapas || []
      });
      estado = { processos: [processoUnico], processoAtualId: processoUnico.id, versao: VERSAO_SCHEMA };
      return;
    }
    throw new Error('Estrutura não reconhecida.');
  }

  async function carregar() {
    try {
      const resposta = await fetch(API_STORAGE_URL, { method: 'GET' });
      if (resposta.ok) {
        const remoto = await resposta.json();
        aplicarEstadoPersistido(remoto);
        try {
          localStorage.setItem(CHAVE_STORAGE, JSON.stringify(montarPayload()));
        } catch (_) {
          // Mantém funcionamento mesmo sem permissão de localStorage.
        }
        return;
      }
    } catch (_) {
      // Em caso de indisponibilidade do backend, usa fallback local.
    }

    try {
      const raw = localStorage.getItem(CHAVE_STORAGE);
      if (!raw) {
        usarDadosExemplo();
        return;
      }
      const local = JSON.parse(raw);
      aplicarEstadoPersistido(local);
      salvar();
    } catch (e) {
      usarDadosExemplo();
    }
  }

  async function atualizarDoServidorSilenciosamente() {
    if (ultimoPayloadPendente || sincronizacaoEmAndamento) return;
    try {
      const resposta = await fetch(API_STORAGE_URL, { method: 'GET' });
      if (!resposta.ok) return;
      const remoto = await resposta.json();
      const snapshotLocal = JSON.stringify(montarPayload());
      const snapshotRemoto = JSON.stringify(remoto);
      if (snapshotRemoto === snapshotLocal) return;

      aplicarEstadoPersistido(remoto);
      renderizarListaProcessos();
      sincronizarUI();
      try {
        localStorage.setItem(CHAVE_STORAGE, JSON.stringify(montarPayload()));
      } catch (_) {
        // Sem impacto funcional se o navegador bloquear localStorage.
      }
      mostrarToast('Dados atualizados com alterações de outro usuário.', 'sucesso');
    } catch (_) {
      // Atualização periódica deve ser silenciosa em caso de falha.
    }
  }

  function usarDadosExemplo() {
    const primeiro = criarProcesso({
      nome: DADOS_EXEMPLO.processo.nome,
      dataGoLive: DADOS_EXEMPLO.processo.dataGoLive || '',
      etapas: DADOS_EXEMPLO.etapas
    });
    estado = { processos: [primeiro], processoAtualId: primeiro.id, versao: VERSAO_SCHEMA };
    salvar();
  }

  function validarSchemaImportacao(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.versao != null && typeof obj.versao !== 'number') return false;
    if (Array.isArray(obj.processos)) {
      for (const pr of obj.processos) {
        if (!pr || typeof pr.nome !== 'string') return false;
        if (pr.dataGoLive != null && typeof pr.dataGoLive !== 'string') return false;
        if (pr.anexos != null && !Array.isArray(pr.anexos)) return false;
        if (pr.anexos) {
          for (const a of pr.anexos) {
            if (!a || typeof a.nome !== 'string') return false;
            const possuiOrigemArquivo =
              (typeof a.dataUrl === 'string' && a.dataUrl) ||
              (typeof a.storageKey === 'string' && a.storageKey);
            if (!possuiOrigemArquivo) return false;
          }
        }
        if (pr.etapas != null && !Array.isArray(pr.etapas)) return false;
        if (pr.etapas) {
          for (const e of pr.etapas) {
            if (!e || typeof e.nome !== 'string') return false;
            if (e.data != null && typeof e.data !== 'string') return false;
            if (e.dataInicio != null && typeof e.dataInicio !== 'string') return false;
            if (e.dataFim != null && typeof e.dataFim !== 'string') return false;
            if (e.area != null && typeof e.area !== 'string') return false;
          }
        }
      }
      return true;
    }
    if (obj.processo != null) {
      if (typeof obj.processo !== 'object' || typeof obj.processo.nome !== 'string') return false;
      if (obj.processo.dataGoLive != null && typeof obj.processo.dataGoLive !== 'string') return false;
      if (obj.processo.anexos != null && !Array.isArray(obj.processo.anexos)) return false;
      if (obj.processo.anexos) {
        for (const a of obj.processo.anexos) {
          if (!a || typeof a.nome !== 'string') return false;
          const possuiOrigemArquivo =
            (typeof a.dataUrl === 'string' && a.dataUrl) ||
            (typeof a.storageKey === 'string' && a.storageKey);
          if (!possuiOrigemArquivo) return false;
        }
      }
    }
    if (obj.etapas != null) {
      if (!Array.isArray(obj.etapas)) return false;
      for (const e of obj.etapas) {
        if (!e || typeof e.nome !== 'string') return false;
        if (e.data != null && typeof e.data !== 'string') return false;
        if (e.dataInicio != null && typeof e.dataInicio !== 'string') return false;
        if (e.dataFim != null && typeof e.dataFim !== 'string') return false;
        if (e.area != null && typeof e.area !== 'string') return false;
      }
    }
    return true;
  }

  // --- DOM e referências ---
  const ref = {
    listaProcessos: document.getElementById('lista-processos'),
    btnNovoProcesso: document.getElementById('btn-novo-processo'),
    mensagemNenhumProcesso: document.getElementById('mensagem-nenhum-processo'),
    indicadorTotalProcessos: document.getElementById('indicador-total-processos'),
    indicadoresStatusProcessos: document.getElementById('indicadores-status-processos'),
    btnExcluirProcesso: document.getElementById('btn-excluir-processo'),
    secaoDadosProcesso: document.getElementById('secao-dados-processo'),
    nomeProcesso: document.getElementById('nome-processo'),
    dataGoLive: document.getElementById('data-go-live'),
    dataGoLiveNaoDefinido: document.getElementById('data-go-live-nao-definido'),
    inputAnexoProcesso: document.getElementById('input-anexo-processo'),
    listaAnexosProcesso: document.getElementById('lista-anexos-processo'),
    mensagemAnexosVazios: document.getElementById('mensagem-anexos-vazios'),
    formProcesso: document.getElementById('form-processo'),
    formEtapa: document.getElementById('form-etapa'),
    nomeEtapa: document.getElementById('nome-etapa'),
    dataInicioEtapa: document.getElementById('data-inicio-etapa'),
    dataInicioEtapaNaoDefinido: document.getElementById('data-inicio-etapa-nao-definido'),
    dataFimEtapa: document.getElementById('data-fim-etapa'),
    dataFimEtapaNaoDefinido: document.getElementById('data-fim-etapa-nao-definido'),
    areaEtapa: document.getElementById('area-etapa'),
    containerOutro: document.getElementById('container-outro'),
    areaOutro: document.getElementById('area-outro'),
    statusEtapa: document.getElementById('status-etapa'),
    corpoTabela: document.getElementById('corpo-tabela'),
    conteudoEtapas: document.getElementById('conteudo-etapas'),
    mensagemEtapasVazias: document.getElementById('mensagem-etapas-vazias'),
    graficoContainer: document.getElementById('grafico-container'),
    canvasGrafico: document.getElementById('grafico-evolucao'),
    placeholderGrafico: document.getElementById('placeholder-grafico'),
    tituloGrafico: document.getElementById('titulo-grafico'),
    btnToggleEtapas: document.getElementById('btn-toggle-etapas'),
    btnLimparTudo: document.getElementById('btn-limpar-tudo'),
    btnExportarJson: document.getElementById('btn-exportar-json'),
    inputImportar: document.getElementById('input-importar'),
    toastContainer: document.getElementById('toast-container'),
    btnAdicionarEtapa: document.getElementById('btn-adicionar-etapa')
  };

  function calcularStatusProcesso(etapas) {
    const lista = Array.isArray(etapas) ? etapas : [];
    if (lista.length === 0) return STATUS_ETAPA_PADRAO;

    const contagem = {};
    STATUS_ETAPA.forEach(status => {
      contagem[status] = 0;
    });

    lista.forEach(etapa => {
      const status = STATUS_ETAPA.includes(etapa.status) ? etapa.status : STATUS_ETAPA_PADRAO;
      contagem[status] += 1;
    });

    if (contagem['Em andamento'] > 0) return 'Em andamento';
    if (contagem['Pausado'] > 0) return 'Pausado';
    if (contagem['Não iniciado'] === lista.length) return 'Não iniciado';
    if (contagem['Concluído'] === lista.length) return 'Concluído';
    if (contagem['Cancelado'] === lista.length) return 'Cancelado';
    if (contagem['Concluído'] > 0 && contagem['Não iniciado'] > 0) return 'Em andamento';
    if (contagem['Não iniciado'] > 0) return 'Não iniciado';
    if (contagem['Concluído'] > 0) return 'Concluído';
    return 'Cancelado';
  }

  function renderizarPainelIndicadores() {
    if (!ref.indicadorTotalProcessos || !ref.indicadoresStatusProcessos) return;

    const totalProcessos = estado.processos.length;
    ref.indicadorTotalProcessos.textContent = String(totalProcessos);

    const contagemPorStatus = {};
    const nomesPorStatus = {};
    STATUS_ETAPA.forEach(status => {
      contagemPorStatus[status] = 0;
      nomesPorStatus[status] = [];
    });

    estado.processos.forEach(processo => {
      const statusProcesso = calcularStatusProcesso(processo.etapas);
      contagemPorStatus[statusProcesso] += 1;
      nomesPorStatus[statusProcesso].push((processo.nome || 'Sem nome').trim() || 'Sem nome');
    });

    ref.indicadoresStatusProcessos.innerHTML = STATUS_ETAPA.map(status => (
      (function() {
        const nomes = nomesPorStatus[status];
        const listaNomesHtml = nomes.length > 0
          ? (
            '<ul class="status-processos-lista">' +
              nomes.map(nome => '<li title="' + escapeHtml(nome) + '">' + escapeHtml(nome) + '</li>').join('') +
            '</ul>'
          )
          : '<p class="status-processos-vazio">Sem processos</p>';

        return (
      '<article class="status-item">' +
        '<div class="status-topo">' +
          '<strong class="status-valor">' + contagemPorStatus[status] + '</strong>' +
          '<span class="status-label">' + escapeHtml(status) + '</span>' +
        '</div>' +
        listaNomesHtml +
      '</article>'
        );
      })()
    )).join('');
  }

  const erros = {
    nomeProcesso: document.getElementById('erro-nome-processo'),
    dataGoLive: document.getElementById('erro-data-go-live'),
    nomeEtapa: document.getElementById('erro-nome-etapa'),
    dataInicioEtapa: document.getElementById('erro-data-inicio-etapa'),
    dataFimEtapa: document.getElementById('erro-data-fim-etapa'),
    areaEtapa: document.getElementById('erro-area-etapa'),
    areaOutro: document.getElementById('erro-area-outro')
  };

  function renderizarAnexosProcesso() {
    if (!ref.listaAnexosProcesso || !ref.mensagemAnexosVazios) return;
    const proc = getProcessoAtual();
    const anexos = proc && Array.isArray(proc.anexos) ? proc.anexos : [];

    ref.listaAnexosProcesso.innerHTML = '';
    ref.mensagemAnexosVazios.hidden = anexos.length > 0;

    anexos.forEach(anexo => {
      const urlDownload = construirUrlDownloadAnexo(anexo);
      const item = document.createElement('li');
      item.className = 'item-anexo-processo';
      item.innerHTML =
        '<div class="anexo-info">' +
          '<span class="anexo-nome" title="' + escapeHtml(anexo.nome) + '">' + escapeHtml(anexo.nome) + '</span>' +
          '<span class="anexo-meta">' + escapeHtml(formatarTamanhoArquivo(anexo.tamanho)) + '</span>' +
        '</div>' +
        '<div class="anexo-acoes">' +
          '<a class="btn btn-secundario" href="' + urlDownload + '" download="' + escapeHtml(anexo.nome) + '">Baixar</a>' +
          '<button type="button" class="btn btn-perigo btn-remover-anexo" data-id="' + escapeHtml(anexo.id) + '">Remover</button>' +
        '</div>';
      ref.listaAnexosProcesso.appendChild(item);
    });

    ref.listaAnexosProcesso.querySelectorAll('.btn-remover-anexo').forEach(btn => {
      btn.addEventListener('click', async () => {
        const processoAtual = getProcessoAtual();
        if (!processoAtual) return;
        const anexoRemovido = (processoAtual.anexos || []).find(anexo => anexo.id === btn.dataset.id);
        processoAtual.anexos = (processoAtual.anexos || []).filter(anexo => anexo.id !== btn.dataset.id);
        if (anexoRemovido && anexoRemovido.storageKey) {
          await excluirAnexoRemoto(anexoRemovido.storageKey);
        }
        salvar();
        renderizarAnexosProcesso();
        mostrarToast('Anexo removido.', 'sucesso');
      });
    });
  }

  function garantirOpcaoNomeEtapa(nomeEtapa) {
    const customAtual = ref.nomeEtapa.querySelector('option[data-custom="true"]');
    if (customAtual) customAtual.remove();

    const valor = (nomeEtapa || '').trim();
    if (!valor) return;

    const existe = Array.from(ref.nomeEtapa.options).some(opt => opt.value === valor);
    if (existe) return;

    const opt = document.createElement('option');
    opt.value = valor;
    opt.textContent = valor + ' (atual)';
    opt.dataset.custom = 'true';
    ref.nomeEtapa.appendChild(opt);
  }

  // --- Toast ---
  function mostrarToast(mensagem, tipo) {
    const div = document.createElement('div');
    div.className = 'toast ' + (tipo === 'erro' ? 'erro' : 'sucesso');
    div.setAttribute('role', 'status');
    div.textContent = mensagem;
    ref.toastContainer.appendChild(div);
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, 3500);
  }

  // --- Validação formulário processo ---
  function validarNomeProcesso() {
    const v = (ref.nomeProcesso.value || '').trim();
    if (v.length < 3) {
      erros.nomeProcesso.textContent = 'Mínimo 3 caracteres.';
      ref.nomeProcesso.classList.add('invalido');
      ref.nomeProcesso.parentElement.classList.add('invalido');
      return false;
    }
    erros.nomeProcesso.textContent = '';
    ref.nomeProcesso.classList.remove('invalido');
    ref.nomeProcesso.parentElement.classList.remove('invalido');
    return true;
  }

  function atualizarEstadoDataGoLive() {
    const naoDefinido = Boolean(ref.dataGoLiveNaoDefinido && ref.dataGoLiveNaoDefinido.checked);
    ref.dataGoLive.disabled = naoDefinido;
    if (naoDefinido) {
      ref.dataGoLive.value = '';
      ref.dataGoLive.classList.remove('invalido');
      ref.dataGoLive.parentElement.classList.remove('invalido');
      erros.dataGoLive.textContent = '';
    }
  }

  if (ref.dataGoLiveNaoDefinido) {
    ref.dataGoLiveNaoDefinido.addEventListener('change', atualizarEstadoDataGoLive);
  }
  ref.dataGoLive.addEventListener('input', () => {
    if (ref.dataGoLive.value && ref.dataGoLiveNaoDefinido && ref.dataGoLiveNaoDefinido.checked) {
      ref.dataGoLiveNaoDefinido.checked = false;
      atualizarEstadoDataGoLive();
    }
  });

  ref.nomeProcesso.addEventListener('blur', validarNomeProcesso);

  // --- Form processo ---
  ref.formProcesso.addEventListener('submit', (e) => {
    e.preventDefault();
    const proc = getProcessoAtual();
    if (!proc) return;
    if (!validarNomeProcesso()) return;
    proc.nome = ref.nomeProcesso.value.trim();
    proc.dataGoLive = ref.dataGoLiveNaoDefinido && ref.dataGoLiveNaoDefinido.checked
      ? ''
      : (ref.dataGoLive.value || '').trim();
    salvar();
    renderizarListaProcessos();
    mostrarToast('Dados do processo salvos.', 'sucesso');
  });

  ref.inputAnexoProcesso.addEventListener('change', async (e) => {
    const proc = getProcessoAtual();
    if (!proc) return;
    const arquivos = Array.from((e.target.files && e.target.files.length ? e.target.files : []));
    if (!arquivos.length) return;

    const invalidos = arquivos.filter(file => !arquivoPermitido(file.name));
    if (invalidos.length > 0) {
      mostrarToast('Um ou mais arquivos têm formato inválido. Envie PDF, Excel ou PowerPoint.', 'erro');
      ref.inputAnexoProcesso.value = '';
      return;
    }

    let anexados = 0;
    try {
      for (const file of arquivos) {
        const remoto = await enviarAnexoRemoto(file, proc.id);
        const novoAnexo = {
          id: remoto.id || gerarId(),
          nome: remoto.nome || file.name,
          tipo: remoto.tipo || file.type || '',
          tamanho: Number.isFinite(Number(remoto.tamanho)) ? Number(remoto.tamanho) : (file.size || 0),
          storageKey: remoto.storageKey || '',
          dataUrl: '',
          enviadoEm: remoto.enviadoEm || new Date().toISOString()
        };
        proc.anexos = [...(Array.isArray(proc.anexos) ? proc.anexos : []), novoAnexo];
        anexados += 1;
      }
      if (anexados > 0) {
        salvar();
        renderizarAnexosProcesso();
        mostrarToast(anexados > 1 ? (anexados + ' documentos anexados.') : 'Documento anexado.', 'sucesso');
      }
    } catch (_) {
      mostrarToast('Não foi possível anexar todos os arquivos no servidor.', 'erro');
    } finally {
      ref.inputAnexoProcesso.value = '';
    }
  });

  // --- Área "Outro" ---
  function atualizarVisibilidadeOutro() {
    const outro = ref.areaEtapa.value === 'Outro';
    ref.containerOutro.hidden = !outro;
    if (!outro) {
      ref.areaOutro.value = '';
      erros.areaOutro.textContent = '';
    }
  }

  ref.areaEtapa.addEventListener('change', atualizarVisibilidadeOutro);

  function atualizarEstadoDatasEtapa() {
    const inicioNaoDefinido = Boolean(ref.dataInicioEtapaNaoDefinido && ref.dataInicioEtapaNaoDefinido.checked);
    const fimNaoDefinido = Boolean(ref.dataFimEtapaNaoDefinido && ref.dataFimEtapaNaoDefinido.checked);

    ref.dataInicioEtapa.disabled = inicioNaoDefinido;
    ref.dataFimEtapa.disabled = fimNaoDefinido;

    if (inicioNaoDefinido) {
      ref.dataInicioEtapa.value = '';
      erros.dataInicioEtapa.textContent = '';
      ref.dataInicioEtapa.classList.remove('invalido');
      ref.dataInicioEtapa.parentElement.classList.remove('invalido');
    }

    if (fimNaoDefinido) {
      ref.dataFimEtapa.value = '';
      erros.dataFimEtapa.textContent = '';
      ref.dataFimEtapa.classList.remove('invalido');
      ref.dataFimEtapa.parentElement.classList.remove('invalido');
    }
  }

  if (ref.dataInicioEtapaNaoDefinido) {
    ref.dataInicioEtapaNaoDefinido.addEventListener('change', atualizarEstadoDatasEtapa);
  }
  if (ref.dataFimEtapaNaoDefinido) {
    ref.dataFimEtapaNaoDefinido.addEventListener('change', atualizarEstadoDatasEtapa);
  }

  ref.dataInicioEtapa.addEventListener('input', () => {
    if (ref.dataInicioEtapa.value && ref.dataInicioEtapaNaoDefinido && ref.dataInicioEtapaNaoDefinido.checked) {
      ref.dataInicioEtapaNaoDefinido.checked = false;
      atualizarEstadoDatasEtapa();
    }
  });
  ref.dataFimEtapa.addEventListener('input', () => {
    if (ref.dataFimEtapa.value && ref.dataFimEtapaNaoDefinido && ref.dataFimEtapaNaoDefinido.checked) {
      ref.dataFimEtapaNaoDefinido.checked = false;
      atualizarEstadoDatasEtapa();
    }
  });

  function getAreaFinal() {
    if (ref.areaEtapa.value !== 'Outro') return ref.areaEtapa.value;
    return (ref.areaOutro.value || '').trim();
  }

  function nomesEtapaIguais(a, b) {
    return (a || '').trim().localeCompare((b || '').trim(), 'pt-BR', { sensitivity: 'base' }) === 0;
  }

  function existeEtapaComMesmoNome(processo, nomeEtapa, idIgnorar) {
    if (!processo || !Array.isArray(processo.etapas)) return false;
    return processo.etapas.some(etapa =>
      etapa &&
      etapa.id !== idIgnorar &&
      nomesEtapaIguais(etapa.nome, nomeEtapa)
    );
  }

  function validarFormEtapa() {
    let ok = true;
    const proc = getProcessoAtual();
    const nome = (ref.nomeEtapa.value || '').trim();
    const inicioNaoDefinido = Boolean(ref.dataInicioEtapaNaoDefinido && ref.dataInicioEtapaNaoDefinido.checked);
    const fimNaoDefinido = Boolean(ref.dataFimEtapaNaoDefinido && ref.dataFimEtapaNaoDefinido.checked);
    const dataInicio = inicioNaoDefinido ? '' : ref.dataInicioEtapa.value;
    const dataFim = fimNaoDefinido ? '' : ref.dataFimEtapa.value;
    const areaSelect = ref.areaEtapa.value;
    const areaOutroVal = (ref.areaOutro.value || '').trim();

    erros.nomeEtapa.textContent = '';
    erros.dataInicioEtapa.textContent = '';
    erros.dataFimEtapa.textContent = '';
    erros.areaEtapa.textContent = '';
    erros.areaOutro.textContent = '';
    ref.nomeEtapa.classList.remove('invalido');
    ref.nomeEtapa.parentElement.classList.remove('invalido');
    ref.dataInicioEtapa.classList.remove('invalido');
    ref.dataInicioEtapa.parentElement.classList.remove('invalido');
    ref.dataFimEtapa.classList.remove('invalido');
    ref.dataFimEtapa.parentElement.classList.remove('invalido');
    ref.areaEtapa.classList.remove('invalido');
    ref.areaEtapa.parentElement.classList.remove('invalido');
    ref.areaOutro.classList.remove('invalido');
    ref.areaOutro.parentElement?.classList.remove('invalido');

    if (!nome) {
      erros.nomeEtapa.textContent = 'Selecione o nome da etapa.';
      ref.nomeEtapa.classList.add('invalido');
      ref.nomeEtapa.parentElement.classList.add('invalido');
      ok = false;
    } else if (existeEtapaComMesmoNome(proc, nome, idEtapaEditando)) {
      erros.nomeEtapa.textContent = 'Esta etapa já foi adicionada neste processo.';
      ref.nomeEtapa.classList.add('invalido');
      ref.nomeEtapa.parentElement.classList.add('invalido');
      ok = false;
    }
    if (!inicioNaoDefinido && (!dataInicio || isNaN(new Date(dataInicio).getTime()))) {
      erros.dataInicioEtapa.textContent = 'Informe uma data válida.';
      ref.dataInicioEtapa.classList.add('invalido');
      ref.dataInicioEtapa.parentElement.classList.add('invalido');
      ok = false;
    }
    if (!fimNaoDefinido && (!dataFim || isNaN(new Date(dataFim).getTime()))) {
      erros.dataFimEtapa.textContent = 'Informe uma data válida.';
      ref.dataFimEtapa.classList.add('invalido');
      ref.dataFimEtapa.parentElement.classList.add('invalido');
      ok = false;
    } else if (dataInicio && dataFim && dataFim < dataInicio) {
      erros.dataFimEtapa.textContent = 'Data de fim deve ser igual ou posterior à data de início.';
      ref.dataFimEtapa.classList.add('invalido');
      ref.dataFimEtapa.parentElement.classList.add('invalido');
      ok = false;
    }
    if (!areaSelect) {
      erros.areaEtapa.textContent = 'Selecione a área.';
      ref.areaEtapa.classList.add('invalido');
      ref.areaEtapa.parentElement.classList.add('invalido');
      ok = false;
    } else if (areaSelect === 'Outro' && !areaOutroVal) {
      erros.areaOutro.textContent = 'Informe a área.';
      ref.areaOutro.classList.add('invalido');
      ref.areaOutro.parentElement?.classList.add('invalido');
      ok = false;
    }
    return ok;
  }

  function limparFormEtapa() {
    ref.formEtapa.reset();
    garantirOpcaoNomeEtapa('');
    if (ref.dataInicioEtapaNaoDefinido) ref.dataInicioEtapaNaoDefinido.checked = false;
    if (ref.dataFimEtapaNaoDefinido) ref.dataFimEtapaNaoDefinido.checked = false;
    atualizarEstadoDatasEtapa();
    ref.areaOutro.value = '';
    ref.statusEtapa.value = STATUS_ETAPA_PADRAO;
    atualizarVisibilidadeOutro();
    erros.nomeEtapa.textContent = '';
    erros.dataInicioEtapa.textContent = '';
    erros.dataFimEtapa.textContent = '';
    erros.areaEtapa.textContent = '';
    erros.areaOutro.textContent = '';
    ref.nomeEtapa.focus();
  }

  // --- Adicionar etapa ---
  ref.formEtapa.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const proc = getProcessoAtual();
    if (!proc) return;
    if (!validarFormEtapa()) return;

    const etapas = proc.etapas;
    if (idEtapaEditando) {
      const etapa = etapas.find(x => x.id === idEtapaEditando);
      if (etapa) {
        etapa.nome = ref.nomeEtapa.value.trim();
        etapa.dataInicio = ref.dataInicioEtapaNaoDefinido && ref.dataInicioEtapaNaoDefinido.checked ? '' : ref.dataInicioEtapa.value;
        etapa.dataFim = ref.dataFimEtapaNaoDefinido && ref.dataFimEtapaNaoDefinido.checked ? '' : ref.dataFimEtapa.value;
        etapa.area = getAreaFinal();
        etapa.status = STATUS_ETAPA.includes(ref.statusEtapa.value) ? ref.statusEtapa.value : STATUS_ETAPA_PADRAO;
        mostrarToast('Etapa atualizada.', 'sucesso');
      }
      idEtapaEditando = null;
    } else {
      const novaEtapa = {
        id: gerarId(),
        nome: ref.nomeEtapa.value.trim(),
        dataInicio: ref.dataInicioEtapaNaoDefinido && ref.dataInicioEtapaNaoDefinido.checked ? '' : ref.dataInicioEtapa.value,
        dataFim: ref.dataFimEtapaNaoDefinido && ref.dataFimEtapaNaoDefinido.checked ? '' : ref.dataFimEtapa.value,
        area: getAreaFinal(),
        status: STATUS_ETAPA.includes(ref.statusEtapa.value) ? ref.statusEtapa.value : STATUS_ETAPA_PADRAO
      };
      proc.etapas = [...etapas, novaEtapa];
      mostrarToast('Etapa adicionada.', 'sucesso');
    }
    salvar();
    limparFormEtapa();
    ref.btnAdicionarEtapa.textContent = 'Adicionar etapa';
    renderizarTabela();
    agendarAtualizacaoGrafico();
  });

  // --- Tabela: renderizar ---
  function renderizarTabela() {
    const proc = getProcessoAtual();
    const etapas = proc ? proc.etapas : [];
    const ordenadas = ordenarEtapasPorData(etapas);
    ref.mensagemEtapasVazias.hidden = ordenadas.length > 0;
    const tbody = ref.corpoTabela;
    tbody.innerHTML = '';

    ordenadas.forEach((etapa, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.id = etapa.id;
      tr.innerHTML =
        '<td>' + (idx + 1) + '</td>' +
        '<td class="col-nome">' + escapeHtml(etapa.nome) + '</td>' +
        '<td class="col-data">' + formatarDataBR(getDataInicio(etapa)) + '</td>' +
        '<td class="col-data">' + formatarDataBR(getDataFim(etapa)) + '</td>' +
        '<td class="col-area">' + escapeHtml(etapa.area) + '</td>' +
        '<td class="col-status">' + escapeHtml(etapa.status || STATUS_ETAPA_PADRAO) + '</td>' +
        '<td class="acoes">' +
        '<button type="button" class="btn btn-secundario btn-editar" data-id="' + escapeHtml(etapa.id) + '" aria-label="Editar etapa">Editar</button> ' +
        '<button type="button" class="btn btn-perigo btn-excluir" data-id="' + escapeHtml(etapa.id) + '" aria-label="Excluir etapa">Excluir</button>' +
        '</td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-editar').forEach(btn => {
      btn.addEventListener('click', () => iniciarEdicao(btn.dataset.id));
    });
    tbody.querySelectorAll('.btn-excluir').forEach(btn => {
      btn.addEventListener('click', () => excluirEtapa(btn.dataset.id));
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function iniciarEdicao(id) {
    const proc = getProcessoAtual();
    if (!proc) return;
    const etapa = proc.etapas.find(e => e.id === id);
    if (!etapa) return;
    idEtapaEditando = id;
    garantirOpcaoNomeEtapa(etapa.nome);
    ref.nomeEtapa.value = etapa.nome;
    ref.dataInicioEtapa.value = getDataInicio(etapa);
    ref.dataFimEtapa.value = getDataFim(etapa);
    if (ref.dataInicioEtapaNaoDefinido) {
      ref.dataInicioEtapaNaoDefinido.checked = !getDataInicio(etapa);
    }
    if (ref.dataFimEtapaNaoDefinido) {
      ref.dataFimEtapaNaoDefinido.checked = !getDataFim(etapa);
    }
    atualizarEstadoDatasEtapa();
    ref.areaEtapa.value = AREAS_PREDEFINIDAS.includes(etapa.area) ? etapa.area : 'Outro';
    ref.areaOutro.value = ref.areaEtapa.value === 'Outro' ? etapa.area : '';
    ref.statusEtapa.value = STATUS_ETAPA.includes(etapa.status) ? etapa.status : STATUS_ETAPA_PADRAO;
    atualizarVisibilidadeOutro();
    ref.btnAdicionarEtapa.textContent = 'Salvar alteração';
    ref.nomeEtapa.focus();
  }

  function excluirEtapa(id) {
    const proc = getProcessoAtual();
    if (!proc) return;
    proc.etapas = proc.etapas.filter(e => e.id !== id);
    salvar();
    renderizarTabela();
    agendarAtualizacaoGrafico();
    mostrarToast('Etapa excluída.', 'sucesso');
  }

  function atualizarBotaoToggleEtapas() {
    if (!ref.btnToggleEtapas || !ref.conteudoEtapas) return;
    ref.conteudoEtapas.hidden = !etapasVisiveis;
    ref.btnToggleEtapas.textContent = etapasVisiveis ? 'Ocultar' : 'Expandir';
    ref.btnToggleEtapas.setAttribute('aria-expanded', etapasVisiveis ? 'true' : 'false');
  }

  ref.btnToggleEtapas.addEventListener('click', () => {
    etapasVisiveis = !etapasVisiveis;
    atualizarBotaoToggleEtapas();
  });

  // --- Limpar tudo ---
  ref.btnLimparTudo.addEventListener('click', () => {
    const proc = getProcessoAtual();
    if (!proc) return;
    proc.etapas = [];
    salvar();
    renderizarTabela();
    agendarAtualizacaoGrafico();
    limparFormEtapa();
    idEtapaEditando = null;
    ref.btnAdicionarEtapa.textContent = 'Adicionar etapa';
    mostrarToast('Todas as etapas deste processo foram removidas.', 'sucesso');
  });

  // --- Gráfico ---
  function agendarAtualizacaoGrafico() {
    if (timeoutGrafico) clearTimeout(timeoutGrafico);
    timeoutGrafico = setTimeout(atualizarGrafico, DEBOUNCE_GRAFICO_MS);
  }

  function atualizarGrafico() {
    timeoutGrafico = null;
    const proc = getProcessoAtual();
    const etapas = proc ? proc.etapas : [];
    const dados = calcularDadosGraficoEvolucao(etapas);

    if (dados.pontosCumulativo.length === 0) {
      if (graficoInstance) {
        graficoInstance.destroy();
        graficoInstance = null;
      }
      const rotulosEl = document.getElementById('grafico-rotulos');
      if (rotulosEl) rotulosEl.innerHTML = '';
      ref.graficoContainer.hidden = true;
      ref.placeholderGrafico.hidden = false;
      return;
    }

    ref.graficoContainer.hidden = false;
    ref.placeholderGrafico.hidden = true;

    const { pontosCumulativo, pontosEtapas, xMin, xMax, hojeISO } = dados;
    const totalEtapas = etapas.length;

    const datasetCumulativo = {
      label: 'Evolução (cumulativo)',
      data: pontosCumulativo,
      borderColor: '#1565c0',
      backgroundColor: 'rgba(21, 101, 192, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      order: 1
    };

    const datasetEtapas = {
      label: 'Etapas',
      data: pontosEtapas.map(p => ({ x: p.x, y: p.y })),
      showLine: false,
      pointStyle: 'circle',
      pointRadius: 6,
      pointHoverRadius: 8,
      backgroundColor: '#ff9800',
      borderColor: '#e65100',
      borderWidth: 1,
      order: 0,
      tension: 0,
      _metaEtapas: pontosEtapas
    };

    const annotations = {
      linhaHoje: {
        type: 'line',
        xMin: hojeISO,
        xMax: hojeISO,
        borderColor: '#9aa0a6',
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: 'Hoje',
          position: 'start',
          backgroundColor: 'rgba(154, 160, 166, 0.8)',
          color: '#fff',
          font: { size: 11 }
        }
      },
      boxProgresso: {
        type: 'box',
        xMin: xMin,
        xMax: hojeISO,
        backgroundColor: 'rgba(33, 150, 243, 0.07)',
        borderWidth: 0
      },
      boxPlanejado: {
        type: 'box',
        xMin: hojeISO,
        xMax: xMax,
        backgroundColor: 'rgba(158, 158, 158, 0.07)',
        borderWidth: 0
      }
    };

    const opcoes = {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { bottom: 82 }
      },
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            label: function(context) {
              const ds = context.chart.data.datasets[context.datasetIndex];
              if (ds._metaEtapas && ds._metaEtapas[context.dataIndex]) {
                const m = ds._metaEtapas[context.dataIndex];
                const linhaHoje = getDataInicio(m.etapa) < hojeISO ? ' (já passou)' : getDataInicio(m.etapa) > hojeISO ? ' (próxima)' : '';
                return [
                  'Nome da etapa: ' + (m.etapa.nome || ''),
                  'Área: ' + (m.etapa.area || ''),
                  'Data: ' + formatarDataBR(m.x),
                  'Cumulativo: Etapa nº ' + m.ordem + ' de ' + m.total + linhaHoje
                ];
              }
              return 'Total: ' + context.parsed.y + ' etapa(s)';
            },
            title: function(context) {
              if (!context.length) return '';
              const ctx = context[0];
              if (ctx.datasetIndex === 1) return 'Etapa';
              const raw = ctx.raw;
              if (raw && raw.x) return 'Data: ' + formatarDataBR(typeof raw.x === 'string' ? raw.x : raw.x.toISOString?.().slice(0, 10) || '');
              return '';
            }
          }
        },
        annotation: {
          annotations
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'day',
            displayFormats: { day: 'dd/MM/yyyy', week: 'dd/MM/yyyy', month: 'dd/MM/yyyy', year: 'yyyy' },
            tooltipFormat: 'dd/MM/yyyy'
          },
          min: xMin,
          max: xMax,
          ticks: { maxTicksLimit: 10 }
        },
        y: {
          beginAtZero: true,
          min: 0,
          max: Math.max(totalEtapas, 1) + 0.5,
          ticks: { stepSize: 1 }
        }
      }
    };

    if (graficoInstance) {
      graficoInstance.data.datasets[0] = datasetCumulativo;
      graficoInstance.data.datasets[1] = datasetEtapas;
      graficoInstance.data.datasets[1]._metaEtapas = pontosEtapas;
      graficoInstance._rotulosEtapas = pontosEtapas;
      graficoInstance.options.plugins.annotation.annotations = annotations;
      graficoInstance.options.scales.x.min = xMin;
      graficoInstance.options.scales.x.max = xMax;
      graficoInstance.options.scales.y.max = Math.max(totalEtapas, 1) + 0.5;
      graficoInstance.update('none');
      return;
    }

    const pluginEtapasAbaixo = {
      id: 'etapasAbaixoEixo',
      afterDraw(chart) {
        const meta = chart._rotulosEtapas || chart.data.datasets[1]?._metaEtapas;
        const container = chart.canvas.nextElementSibling;
        if (!container || container.id !== 'grafico-rotulos') return;
        if (!meta || !meta.length || !chart.scales.x) {
          container.innerHTML = '';
          return;
        }
        const scaleX = chart.scales.x;
        const chartWidth = chart.width;
        if (chartWidth <= 0) return;
        const porX = {};
        meta.forEach(p => {
          const x = p.x;
          if (!porX[x]) porX[x] = [];
          porX[x].push(p.etapa.nome || '');
        });
        let html = '';
        Object.keys(porX).forEach(xVal => {
          const timestamp = new Date(xVal + (xVal.indexOf('T') >= 0 ? '' : 'T12:00:00')).getTime();
          const pixelX = scaleX.getPixelForValue(timestamp);
          if (typeof pixelX !== 'number' || isNaN(pixelX)) return;
          const nomes = porX[xVal];
          const nomeCompleto = (nomes[0] || '').trim() || 'Etapa';
          const leftPct = (pixelX / chartWidth) * 100;
          const titulo = nomeCompleto.replace(/"/g, '&quot;');
          html += '<span class="rotulo-etapa" style="left:' + leftPct + '%;" title="' + titulo + '">' + escapeHtml(nomeCompleto) + '</span>';
        });
        container.innerHTML = html;
      }
    };

    const ctx = ref.canvasGrafico.getContext('2d');
    graficoInstance = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [datasetCumulativo, datasetEtapas]
      },
      options: opcoes,
      plugins: [pluginEtapasAbaixo]
    });
    graficoInstance._rotulosEtapas = pontosEtapas;
  }

  // --- Exportar JSON ---
  ref.btnExportarJson.addEventListener('click', () => {
    const payload = montarPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'processos-etapas.json';
    a.click();
    URL.revokeObjectURL(a.href);
    mostrarToast('JSON exportado.', 'sucesso');
  });

  // --- Importar JSON ---
  ref.inputImportar.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!validarSchemaImportacao(obj)) {
          mostrarToast('Arquivo JSON inválido. Verifique o formato.', 'erro');
          ref.inputImportar.value = '';
          return;
        }
        if (Array.isArray(obj.processos) && obj.processos.length > 0) {
          estado.processos = obj.processos.map(pr => ({
            id: pr.id && typeof pr.id === 'string' ? pr.id : gerarId(),
            nome: typeof pr.nome === 'string' ? pr.nome : 'Sem nome',
            dataGoLive: typeof pr.dataGoLive === 'string' ? pr.dataGoLive : '',
            anexos: normalizarAnexos(pr.anexos || []),
            etapas: normalizarEtapas(pr.etapas || [])
          }));
          estado.processoAtualId = obj.processoAtualId && estado.processos.some(p => p.id === obj.processoAtualId) ? obj.processoAtualId : estado.processos[0].id;
        } else {
          const processoUnico = criarProcesso({
            nome: obj.processo && typeof obj.processo.nome === 'string' ? obj.processo.nome : '',
            dataGoLive: obj.processo && typeof obj.processo.dataGoLive === 'string' ? obj.processo.dataGoLive : '',
            anexos: obj.processo && Array.isArray(obj.processo.anexos) ? obj.processo.anexos : [],
            etapas: obj.etapas || []
          });
          estado.processos = [processoUnico];
          estado.processoAtualId = processoUnico.id;
        }
        estado.versao = obj.versao != null ? obj.versao : VERSAO_SCHEMA;
        salvar();
        renderizarListaProcessos();
        sincronizarUI();
        limparFormEtapa();
        idEtapaEditando = null;
        ref.btnAdicionarEtapa.textContent = 'Adicionar etapa';
        mostrarToast('Dados importados com sucesso.', 'sucesso');
      } catch (err) {
        mostrarToast('Erro ao ler o arquivo JSON.', 'erro');
      }
      ref.inputImportar.value = '';
    };
    reader.readAsText(file, 'UTF-8');
  });

  // --- Lista de processos: renderizar e seleção ---
  function renderizarListaProcessos() {
    ref.listaProcessos.innerHTML = '';
    ref.mensagemNenhumProcesso.hidden = estado.processos.length > 0;
    estado.processos.forEach(pr => {
      const item = document.createElement('div');
      item.className = 'item-processo' + (pr.id === estado.processoAtualId ? ' ativo' : '');
      item.dataset.id = pr.id;

      const seletor = document.createElement('button');
      seletor.type = 'button';
      seletor.className = 'item-processo-seletor';
      seletor.setAttribute('role', 'tab');
      seletor.setAttribute('aria-selected', pr.id === estado.processoAtualId ? 'true' : 'false');
      seletor.innerHTML = '<span class="nome-processo" title="' + escapeHtml(pr.nome) + '">' + escapeHtml(pr.nome) + '</span>';
      seletor.addEventListener('click', () => selectProcesso(pr.id));
      item.appendChild(seletor);

      const anexos = Array.isArray(pr.anexos) ? pr.anexos : [];
      if (anexos.length > 0) {
        const anexosEl = document.createElement('div');
        anexosEl.className = 'item-processo-anexos';
        anexosEl.innerHTML = anexos.map(anexo => (
          '<a class="link-anexo-processo" href="' + construirUrlDownloadAnexo(anexo) + '" download="' + escapeHtml(anexo.nome) + '" title="' + escapeHtml(anexo.nome) + '">' +
            'Documentação' +
          '</a>'
        )).join('');
        item.appendChild(anexosEl);
      }

      ref.listaProcessos.appendChild(item);
    });
  }

  function selectProcesso(id) {
    if (!estado.processos.some(p => p.id === id)) return;
    estado.processoAtualId = id;
    salvar();
    renderizarListaProcessos();
    sincronizarUI();
  }

  ref.btnNovoProcesso.addEventListener('click', () => {
    const nomeInformado = prompt('Informe o nome do novo processo:');
    if (nomeInformado == null) return;
    const nomeFinal = nomeInformado.trim();
    if (!nomeFinal) {
      mostrarToast('Informe um nome para criar o processo.', 'erro');
      return;
    }
    const novo = criarProcesso({ nome: nomeFinal, dataGoLive: '', etapas: [] });
    estado.processos.push(novo);
    estado.processoAtualId = novo.id;
    salvar();
    renderizarListaProcessos();
    sincronizarUI();
    ref.nomeProcesso.focus();
    mostrarToast('Novo processo criado.', 'sucesso');
  });

  ref.btnExcluirProcesso.addEventListener('click', () => {
    const proc = getProcessoAtual();
    if (!proc) return;
    if (estado.processos.length <= 1) {
      mostrarToast('Não é possível excluir o único processo.', 'erro');
      return;
    }
    if (!confirm('Excluir o processo "' + proc.nome + '" e todas as suas etapas?')) return;
    estado.processos = estado.processos.filter(p => p.id !== proc.id);
    estado.processoAtualId = estado.processos[0].id;
    salvar();
    renderizarListaProcessos();
    sincronizarUI();
    limparFormEtapa();
    idEtapaEditando = null;
    ref.btnAdicionarEtapa.textContent = 'Adicionar etapa';
    mostrarToast('Processo excluído.', 'sucesso');
  });

  // --- Sincronizar UI com estado (processo atual) ---
  function sincronizarUI() {
    const proc = getProcessoAtual();
    ref.secaoDadosProcesso.hidden = !proc;
    if (ref.tituloGrafico) {
      ref.tituloGrafico.textContent = proc ? 'Evolução: ' + (proc.nome || 'Processo') + ' (etapas planejadas)' : 'Evolução do Processo (etapas planejadas)';
    }
    if (proc) {
      ref.nomeProcesso.value = proc.nome || '';
      ref.dataGoLive.value = proc.dataGoLive || '';
      if (ref.dataGoLiveNaoDefinido) {
        ref.dataGoLiveNaoDefinido.checked = !proc.dataGoLive;
      }
      atualizarEstadoDataGoLive();
    }
    renderizarAnexosProcesso();
    renderizarTabela();
    atualizarGrafico();
    renderizarPainelIndicadores();
  }

  // --- Inicialização ---
  async function inicializar() {
    await carregar();
    removerProcessosPadraoNovo();
    renderizarListaProcessos();
    sincronizarUI();
    atualizarVisibilidadeOutro();
    atualizarBotaoToggleEtapas();
    setInterval(atualizarDoServidorSilenciosamente, INTERVALO_ATUALIZACAO_REMOTA_MS);
  }

  inicializar();
})();
