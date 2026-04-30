(function () {
  'use strict';

  if (typeof Chart !== 'undefined' && window.chartjsPluginAnnotation) {
    Chart.register(window.chartjsPluginAnnotation);
  }

  const VERSAO_SCHEMA = 2;
  const DEBOUNCE_GRAFICO_MS = 300;
  const DEBOUNCE_PERSIST_MS = 600;
  const INTERVALO_POLL_MS = 12000;

  let persistTimer = null;
  let persistInFlight = false;
  let dirty = false;
  let lastSyncedJson = '';

  const AREAS_PREDEFINIDAS = [
    'Compras', 'Financeiro', 'TI', 'Operações', 'RH', 'Jurídico', 'Comercial', 'Qualidade'
  ];

  const STATUS_ETAPA = ['Não iniciado', 'Em andamento', 'Concluído', 'Pausado', 'Cancelado'];
  const STATUS_ETAPA_PADRAO = 'Não iniciado';

  const DADOS_EXEMPLO = {
    processo: { nome: 'Implantação de Sistema', dataGoLive: '2026-03-25' },
    etapas: [
      { id: null, nome: 'Mapeamento de processos', dataInicio: '2026-03-01', dataFim: '2026-03-05', area: 'Qualidade', status: 'Não iniciado' },
      { id: null, nome: 'Aquisição de licenças', dataInicio: '2026-03-05', dataFim: '2026-03-08', area: 'Compras', status: 'Não iniciado' },
      { id: null, nome: 'Instalação do ambiente', dataInicio: '2026-03-10', dataFim: '2026-03-15', area: 'TI', status: 'Não iniciado' },
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

  function atualizarIndicadorSync(modo) {
    const el = document.getElementById('status-servidor');
    if (!el) return;
    if (modo === 'loading') el.textContent = 'Sincronizando com o servidor…';
    else if (modo === 'ok') el.textContent = 'Dados compartilhados: todos veem a mesma informação ao acessar o site.';
    else if (modo === 'dirty') el.textContent = 'Há alterações locais; serão gravadas em instantes.';
    else if (modo === 'erro') el.textContent = 'Não foi possível sincronizar. Configure o Vercel Blob (BLOB_READ_WRITE_TOKEN) nas variáveis de ambiente.';
    else el.textContent = '';
  }

  function buildPayload() {
    return {
      processos: estado.processos.map(pr => ({
        id: pr.id,
        nome: pr.nome,
        dataGoLive: pr.dataGoLive || '',
        anexos: normalizarAnexos(pr.anexos || []),
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

  async function persistirEstado(opts) {
    const silent = opts && opts.silent;
    persistInFlight = true;
    atualizarIndicadorSync('loading');
    try {
      const payload = buildPayload();
      const r = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(body.message || body.error || 'HTTP ' + r.status);
      }
      lastSyncedJson = JSON.stringify(payload);
      dirty = false;
      atualizarIndicadorSync('ok');
      if (!silent) mostrarToast('Salvo no servidor.', 'sucesso');
    } catch (e) {
      atualizarIndicadorSync('erro');
      mostrarToast('Erro ao salvar no servidor: ' + (e && e.message ? e.message : String(e)), 'erro');
    } finally {
      persistInFlight = false;
    }
  }

  function salvar() {
    dirty = true;
    atualizarIndicadorSync('dirty');
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistirEstado({ silent: true });
    }, DEBOUNCE_PERSIST_MS);
  }

  async function persistirImediato(opts) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistirEstado(opts);
  }

  function normalizarEtapas(etapas) {
    return (Array.isArray(etapas) ? etapas : [])
      .filter(e => e && typeof e.nome === 'string' && (e.data || e.dataInicio))
      .map(e => ({
        id: e.id && typeof e.id === 'string' ? e.id : gerarId(),
        nome: e.nome.trim(),
        dataInicio: e.dataInicio || e.data,
        dataFim: e.dataFim != null && e.dataFim !== '' ? e.dataFim : (e.data || e.dataInicio),
        area: typeof e.area === 'string' ? e.area.trim() : 'Operações',
        status: e.status && STATUS_ETAPA.includes(e.status) ? e.status : STATUS_ETAPA_PADRAO
      }));
  }

  function criarProcesso(opt) {
    const nome = opt && typeof opt.nome === 'string' ? opt.nome : 'Novo processo';
    const dataGoLive = opt && typeof opt.dataGoLive === 'string' ? opt.dataGoLive : '';
    const etapas = opt && Array.isArray(opt.etapas) ? normalizarEtapas(opt.etapas) : [];
    return { id: gerarId(), nome, dataGoLive, etapas, anexos: [] };
  }

  function normalizarAnexos(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(a => a && typeof a.url === 'string' && /^https?:\/\//i.test(a.url))
      .map(a => ({
        id: a.id && typeof a.id === 'string' ? a.id : gerarId(),
        nome: typeof a.nome === 'string' ? a.nome : 'Arquivo',
        url: a.url,
        uploadedAt: typeof a.uploadedAt === 'string' ? a.uploadedAt : ''
      }));
  }

  function removerProcessosPadraoNovo() {
    const antes = estado.processos.length;
    estado.processos = estado.processos.filter(pr => {
      const nomePadrao = (pr.nome || '').trim() === 'Novo processo';
      const semEtapas = !Array.isArray(pr.etapas) || pr.etapas.length === 0;
      const semAnexos = !Array.isArray(pr.anexos) || pr.anexos.length === 0;
      const semConteudo = (!pr.dataGoLive || pr.dataGoLive.trim() === '') && semEtapas && semAnexos;
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

  function seedExemploMemoria() {
    const primeiro = criarProcesso({
      nome: DADOS_EXEMPLO.processo.nome,
      dataGoLive: DADOS_EXEMPLO.processo.dataGoLive || '',
      etapas: DADOS_EXEMPLO.etapas
    });
    estado = { processos: [primeiro], processoAtualId: primeiro.id, versao: VERSAO_SCHEMA };
  }

  function aplicarDadosCarregados(data) {
    if (!data || typeof data !== 'object') {
      seedExemploMemoria();
      return;
    }
    const ver = data.versao == null ? 1 : data.versao;
    if (Array.isArray(data.processos) && data.processos.length > 0) {
      const processos = data.processos.map(pr => ({
        id: pr.id && typeof pr.id === 'string' ? pr.id : gerarId(),
        nome: typeof pr.nome === 'string' ? pr.nome : 'Sem nome',
        dataGoLive: typeof pr.dataGoLive === 'string' ? pr.dataGoLive : '',
        anexos: normalizarAnexos(pr.anexos),
        etapas: normalizarEtapas(pr.etapas || [])
      }));
      let processoAtualId = processos[0].id;
      if (data.processoAtualId && processos.some(p => p.id === data.processoAtualId)) processoAtualId = data.processoAtualId;
      estado = { processos, processoAtualId, versao: ver };
    } else {
      const processoUnico = criarProcesso({
        nome: data.processo && typeof data.processo.nome === 'string' ? data.processo.nome : '',
        dataGoLive: data.processo && typeof data.processo.dataGoLive === 'string' ? data.processo.dataGoLive : '',
        etapas: data.etapas || []
      });
      estado = { processos: [processoUnico], processoAtualId: processoUnico.id, versao: VERSAO_SCHEMA };
    }
  }

  async function carregarDoServidor() {
    atualizarIndicadorSync('loading');
    try {
      const r = await fetch('/api/state', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || 'Erro ao carregar dados do servidor.';
        mostrarToast(msg, 'erro');
        atualizarIndicadorSync('erro');
        return;
      }
      if (data == null) {
        seedExemploMemoria();
      } else if (typeof data === 'object' && data.error) {
        seedExemploMemoria();
      } else if (Array.isArray(data.processos) && data.processos.length === 0) {
        seedExemploMemoria();
      } else {
        aplicarDadosCarregados(data);
      }
      lastSyncedJson = JSON.stringify(buildPayload());
      dirty = false;
      atualizarIndicadorSync('ok');
    } catch (e) {
      mostrarToast('Erro de rede ao carregar.', 'erro');
      seedExemploMemoria();
      atualizarIndicadorSync('erro');
    }
  }

  async function tentarSincronizarRemoto() {
    if (document.visibilityState !== 'visible') return;
    if (dirty || persistInFlight) return;
    try {
      const r = await fetch('/api/state', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();
      if (data == null || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.error || !Array.isArray(data.processos)) return;
      const antes = JSON.stringify(buildPayload());
      aplicarDadosCarregados(data);
      const depois = JSON.stringify(buildPayload());
      if (antes === depois) return;
      lastSyncedJson = depois;
      renderizarListaProcessos();
      sincronizarUI();
      mostrarToast('Lista atualizada (outro usuário alterou os dados).', 'sucesso');
    } catch (e) {
      /* silencioso */
    }
  }

  function usarDadosExemplo() {
    seedExemploMemoria();
  }

  function validarSchemaImportacao(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.versao != null && typeof obj.versao !== 'number') return false;
    if (Array.isArray(obj.processos)) {
      for (const pr of obj.processos) {
        if (!pr || typeof pr.nome !== 'string') return false;
        if (pr.dataGoLive != null && typeof pr.dataGoLive !== 'string') return false;
        if (pr.anexos != null && !Array.isArray(pr.anexos)) return false;
        if (pr.etapas != null && !Array.isArray(pr.etapas)) return false;
        if (pr.etapas) {
          for (const e of pr.etapas) {
            if (!e || typeof e.nome !== 'string') return false;
            const temData = (e.data && typeof e.data === 'string') || (e.dataInicio && typeof e.dataInicio === 'string');
            if (!temData) return false;
            if (e.area != null && typeof e.area !== 'string') return false;
          }
        }
      }
      return true;
    }
    if (obj.processo != null) {
      if (typeof obj.processo !== 'object' || typeof obj.processo.nome !== 'string') return false;
      if (obj.processo.dataGoLive != null && typeof obj.processo.dataGoLive !== 'string') return false;
    }
    if (obj.etapas != null) {
      if (!Array.isArray(obj.etapas)) return false;
      for (const e of obj.etapas) {
        if (!e || typeof e.nome !== 'string') return false;
        const temData = (e.data && typeof e.data === 'string') || (e.dataInicio && typeof e.dataInicio === 'string');
        if (!temData) return false;
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
    btnExcluirProcesso: document.getElementById('btn-excluir-processo'),
    secaoDadosProcesso: document.getElementById('secao-dados-processo'),
    nomeProcesso: document.getElementById('nome-processo'),
    dataGoLive: document.getElementById('data-go-live'),
    formProcesso: document.getElementById('form-processo'),
    formEtapa: document.getElementById('form-etapa'),
    nomeEtapa: document.getElementById('nome-etapa'),
    dataInicioEtapa: document.getElementById('data-inicio-etapa'),
    dataFimEtapa: document.getElementById('data-fim-etapa'),
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
    btnSalvarAgora: document.getElementById('btn-salvar-agora'),
    btnExportarJson: document.getElementById('btn-exportar-json'),
    inputImportar: document.getElementById('input-importar'),
    inputAnexos: document.getElementById('input-anexos'),
    listaAnexos: document.getElementById('lista-anexos'),
    toastContainer: document.getElementById('toast-container'),
    btnAdicionarEtapa: document.getElementById('btn-adicionar-etapa')
  };

  const erros = {
    nomeProcesso: document.getElementById('erro-nome-processo'),
    dataGoLive: document.getElementById('erro-data-go-live'),
    nomeEtapa: document.getElementById('erro-nome-etapa'),
    dataInicioEtapa: document.getElementById('erro-data-inicio-etapa'),
    dataFimEtapa: document.getElementById('erro-data-fim-etapa'),
    areaEtapa: document.getElementById('erro-area-etapa'),
    areaOutro: document.getElementById('erro-area-outro')
  };

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

  ref.nomeProcesso.addEventListener('blur', validarNomeProcesso);

  // --- Form processo ---
  ref.formProcesso.addEventListener('submit', (e) => {
    e.preventDefault();
    const proc = getProcessoAtual();
    if (!proc) return;
    if (!validarNomeProcesso()) return;
    proc.nome = ref.nomeProcesso.value.trim();
    proc.dataGoLive = (ref.dataGoLive.value || '').trim();
    salvar();
    renderizarListaProcessos();
    mostrarToast('Dados do processo salvos.', 'sucesso');
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

  function getAreaFinal() {
    if (ref.areaEtapa.value !== 'Outro') return ref.areaEtapa.value;
    return (ref.areaOutro.value || '').trim();
  }

  function validarFormEtapa() {
    let ok = true;
    const nome = (ref.nomeEtapa.value || '').trim();
    const dataInicio = ref.dataInicioEtapa.value;
    const dataFim = ref.dataFimEtapa.value;
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

    if (nome.length < 3) {
      erros.nomeEtapa.textContent = 'Mínimo 3 caracteres.';
      ref.nomeEtapa.classList.add('invalido');
      ref.nomeEtapa.parentElement.classList.add('invalido');
      ok = false;
    }
    if (!dataInicio || isNaN(new Date(dataInicio).getTime())) {
      erros.dataInicioEtapa.textContent = 'Informe uma data válida.';
      ref.dataInicioEtapa.classList.add('invalido');
      ref.dataInicioEtapa.parentElement.classList.add('invalido');
      ok = false;
    }
    if (!dataFim || isNaN(new Date(dataFim).getTime())) {
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
        etapa.dataInicio = ref.dataInicioEtapa.value;
        etapa.dataFim = ref.dataFimEtapa.value;
        etapa.area = getAreaFinal();
        etapa.status = STATUS_ETAPA.includes(ref.statusEtapa.value) ? ref.statusEtapa.value : STATUS_ETAPA_PADRAO;
        mostrarToast('Etapa atualizada.', 'sucesso');
      }
      idEtapaEditando = null;
    } else {
      const novaEtapa = {
        id: gerarId(),
        nome: ref.nomeEtapa.value.trim(),
        dataInicio: ref.dataInicioEtapa.value,
        dataFim: ref.dataFimEtapa.value,
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
    ref.nomeEtapa.value = etapa.nome;
    ref.dataInicioEtapa.value = getDataInicio(etapa);
    ref.dataFimEtapa.value = getDataFim(etapa);
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
  if (ref.btnSalvarAgora) {
    ref.btnSalvarAgora.addEventListener('click', async () => {
      if (persistInFlight) {
        mostrarToast('Sincronização em andamento, aguarde alguns segundos.', 'erro');
        return;
      }
      await persistirImediato({ silent: false });
    });
  }

  ref.btnExportarJson.addEventListener('click', () => {
    const payload = {
      processos: estado.processos.map(pr => ({
        id: pr.id,
        nome: pr.nome,
        dataGoLive: pr.dataGoLive || '',
        anexos: normalizarAnexos(pr.anexos || []),
        etapas: pr.etapas.map(e => ({
          id: e.id,
          nome: e.nome,
          dataInicio: getDataInicio(e),
          dataFim: getDataFim(e),
          area: e.area,
          status: e.status || STATUS_ETAPA_PADRAO
        }))
      })),
      processoAtualId: estado.processoAtualId,
      versao: estado.versao
    };
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
      (async () => {
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
              anexos: normalizarAnexos(pr.anexos),
              etapas: normalizarEtapas(pr.etapas || [])
            }));
            estado.processoAtualId = obj.processoAtualId && estado.processos.some(p => p.id === obj.processoAtualId) ? obj.processoAtualId : estado.processos[0].id;
          } else {
            const processoUnico = criarProcesso({
              nome: obj.processo && typeof obj.processo.nome === 'string' ? obj.processo.nome : '',
              dataGoLive: obj.processo && typeof obj.processo.dataGoLive === 'string' ? obj.processo.dataGoLive : '',
              etapas: obj.etapas || []
            });
            estado.processos = [processoUnico];
            estado.processoAtualId = processoUnico.id;
          }
          estado.versao = obj.versao != null ? obj.versao : VERSAO_SCHEMA;
          renderizarListaProcessos();
          sincronizarUI();
          limparFormEtapa();
          idEtapaEditando = null;
          ref.btnAdicionarEtapa.textContent = 'Adicionar etapa';
          await persistirImediato({ silent: true });
          mostrarToast('Dados importados e gravados no servidor.', 'sucesso');
        } catch (err) {
          mostrarToast('Erro ao ler o arquivo JSON.', 'erro');
        } finally {
          ref.inputImportar.value = '';
        }
      })();
    };
    reader.readAsText(file, 'UTF-8');
  });

  // --- Upload de arquivos (Blob na Vercel) ---
  if (ref.inputAnexos) {
    ref.inputAnexos.addEventListener('change', (e) => {
      const input = e.target;
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      (async () => {
        const proc = getProcessoAtual();
        if (!proc) return;
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/upload', { method: 'POST', body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.message || j.error || 'Falha no upload');
          proc.anexos = proc.anexos || [];
          proc.anexos.push({
            id: gerarId(),
            nome: j.nome || file.name,
            url: j.url,
            uploadedAt: new Date().toISOString()
          });
          renderizarAnexos();
          await persistirImediato({ silent: true });
          mostrarToast('Arquivo enviado; todos os usuários podem acessá-lo.', 'sucesso');
        } catch (err) {
          mostrarToast(err.message || 'Erro no envio do arquivo.', 'erro');
        }
      })();
    });
  }

  // --- Lista de processos: renderizar e seleção ---
  function renderizarListaProcessos() {
    ref.listaProcessos.innerHTML = '';
    ref.mensagemNenhumProcesso.hidden = estado.processos.length > 0;
    estado.processos.forEach(pr => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item-processo' + (pr.id === estado.processoAtualId ? ' ativo' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', pr.id === estado.processoAtualId ? 'true' : 'false');
      btn.dataset.id = pr.id;
      btn.innerHTML = '<span class="nome-processo" title="' + escapeHtml(pr.nome) + '">' + escapeHtml(pr.nome) + '</span>';
      btn.addEventListener('click', () => selectProcesso(pr.id));
      ref.listaProcessos.appendChild(btn);
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
  function renderizarAnexos() {
    if (!ref.listaAnexos) return;
    const proc = getProcessoAtual();
    ref.listaAnexos.innerHTML = '';
    if (!proc) return;
    const anexos = Array.isArray(proc.anexos) ? proc.anexos : [];
    anexos.forEach(a => {
      const li = document.createElement('li');
      li.className = 'item-anexo';
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = a.nome || 'Arquivo';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secundario btn-perigo';
      btn.textContent = 'Remover';
      btn.addEventListener('click', () => {
        proc.anexos = (proc.anexos || []).filter(x => x.id !== a.id);
        salvar();
        renderizarAnexos();
      });
      li.appendChild(link);
      li.appendChild(btn);
      ref.listaAnexos.appendChild(li);
    });
  }

  function sincronizarUI() {
    const proc = getProcessoAtual();
    ref.secaoDadosProcesso.hidden = !proc;
    if (ref.tituloGrafico) {
      ref.tituloGrafico.textContent = proc ? 'Evolução: ' + (proc.nome || 'Processo') + ' (etapas planejadas)' : 'Evolução do Processo (etapas planejadas)';
    }
    if (proc) {
      ref.nomeProcesso.value = proc.nome || '';
      ref.dataGoLive.value = proc.dataGoLive || '';
    }
    renderizarTabela();
    atualizarGrafico();
    renderizarAnexos();
  }

  function persistirAoSair() {
    if (!dirty) return;
    try {
      const payload = buildPayload();
      fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    } catch (e) {
      /* silencioso */
    }
  }

  // --- Inicialização ---
  (async function inicializar() {
    await carregarDoServidor();
    removerProcessosPadraoNovo();
    renderizarListaProcessos();
    sincronizarUI();
    atualizarVisibilidadeOutro();
    atualizarBotaoToggleEtapas();
    setInterval(tentarSincronizarRemoto, INTERVALO_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistirAoSair();
      if (document.visibilityState === 'visible') tentarSincronizarRemoto();
    });
    window.addEventListener('pagehide', persistirAoSair);
  })();
})();
