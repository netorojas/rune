/* ============================================================
   RUNE · ATLAS — runtime local-first
   lê /api/snapshot, hidrata a cena e as dez alas
   ============================================================ */
(() => {
  "use strict";

  /* ---------------------------------------------------------- helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const I18N = window.RUNE_I18N;
  const tr = (key, vars) => (I18N ? I18N.t(state.lang, key, vars) : key);
  const locale = () => (I18N && I18N.locales[state.lang]) || "pt-BR";
  const fmtCache = new Map();
  const nfFor = (opts = {}) => {
    const key = `${locale()}|${JSON.stringify(opts)}`;
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(locale(), opts));
    return fmtCache.get(key);
  };
  const dec = (v, digits = 1) => nfFor({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(v) || 0);
  const int = (v) => nfFor({ maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0));
  const pct = (v, digits = 1) => `${dec(v, digits)}%`;
  const CURRENCIES = { BRL: "R$", USD: "$", EUR: "€" };
  // O 9router grava custo em USD. As taxas guardadas são "quantos BRL valem 1 USD/EUR".
  const ratePerUsd = (code) => {
    const brl = Number(state.rates.USD) > 0 ? Number(state.rates.USD) : 1;
    if (code === "USD") return 1;
    if (code === "BRL") return brl;
    const local = Number(state.rates[code]) > 0 ? Number(state.rates[code]) : brl;
    return brl / local;
  };
  const toDisplay = (v) => (Number(v) || 0) * ratePerUsd(state.currency);
  const fromDisplay = (v) => (Number(v) || 0) / ratePerUsd(state.currency);
  const money = (v) => {
    const opts = { style: "currency", currency: state.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 };
    try { return nfFor(opts).format(toDisplay(v)); }
    catch { return `${CURRENCIES[state.currency] || ""} ${dec(toDisplay(v), 2)}`; }
  };
  const moneyTight = money;
  const compact = (v) => {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1e9) return `${dec(n / 1e9, 2)}B`;
    if (Math.abs(n) >= 1e6) return `${dec(n / 1e6, 2)}M`;
    if (Math.abs(n) >= 1e3) return `${dec(n / 1e3, 1)}k`;
    return String(Math.round(n));
  };
  const modelName = (v) => String(v || "").replace(/^.*\//, "");
  const dateObj = (v) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split("-").map(Number);
      return new Date(y, m - 1, d, 12);
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const weekdayName = (d) => new Intl.DateTimeFormat(locale(), { weekday: "long" }).format(d);
  const monthShort = (d) => new Intl.DateTimeFormat(locale(), { month: "short" }).format(d).replace(/\.$/, "");
  const longDate = (iso) => {
    const d = dateObj(iso) || new Date();
    return `${weekdayName(d)}, ${d.getDate()} ${monthShort(d)}`;
  };
  const timeShort = (iso) => {
    const d = dateObj(iso);
    return d ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "—";
  };
  const latency = (v) => {
    const n = Number(v);
    if (!n) return "—";
    return n < 1000 ? `${Math.round(n)} ms` : `${dec(n / 1000, 1)} s`;
  };
  const ago = (seconds) => {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60) return tr("common.now");
    if (s < 3600) return tr("common.minAgo", { n: Math.round(s / 60) });
    if (s < 86400) return tr("common.hourAgo", { n: dec(s / 3600, 1) });
    return tr("common.dayAgo", { n: Math.round(s / 86400) });
  };
  const until = (iso) => {
    const d = dateObj(iso);
    if (!d) return "—";
    const diff = d.getTime() - Date.now();
    if (diff <= 0) return tr("common.now");
    const m = Math.round(diff / 60000);
    if (m < 60) return tr("common.inMin", { n: m });
    const h = diff / 3600000;
    if (h < 24) return tr("common.inHour", { n: dec(h, 1) });
    return tr("common.inDay", { n: dec(diff / 86400000, 1) });
  };
  const rel = (iso) => {
    const d = dateObj(iso);
    if (!d) return "—";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    return ago(s);
  };
  const maskEmail = (value) => {    const v = String(value || "");
    if (!v.includes("@")) return v;
    const [user, domain] = v.split("@");
    const u = user.length > 1 ? `${user[0]}•••` : "•";
    const dparts = domain.split(".");
    const d = `${dparts[0][0] || "•"}•••${dparts[1] ? `.${dparts[1]}` : ""}`;
    return `${u}@${d}`;
  };
  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return tr("hero.greetingMorning");
    if (h < 18) return tr("hero.greetingAfternoon");
    return tr("hero.greetingEvening");
  };
  const nkey = (v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const uuidShort = (v) => String(v || "").slice(0, 8);

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`rune.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`rune.${key}`, JSON.stringify(value)); } catch { /* noop */ }
    },
  };

  /* ---------------------------------------------------------- frota */

  const PROVIDERS = {
    codex: { name: "Codex", color: "#2f9e6b", vendor: "OpenAI", glyph: "C" },
    claude: { name: "Claude", color: "#d97757", vendor: "Anthropic", glyph: "A" },
    antigravity: { name: "Antigravity", color: "#8b7ad4", vendor: "Google", glyph: "G" },
    "gemini-cli": { name: "Gemini CLI", color: "#4a8bf5", vendor: "Google", glyph: "G" },
    gemini: { name: "Gemini", color: "#4a8bf5", vendor: "Google", glyph: "G" },
    openrouter: { name: "OpenRouter", color: "#4f7fd8", vendor: "OpenRouter", glyph: "O" },
    nvidia: { name: "NVIDIA NIM", color: "#76b900", vendor: "NVIDIA", glyph: "N" },
    ollama: { name: "Ollama", color: "#6a8794", vendor: "local", glyph: "O" },
    "cloudflare-ai": { name: "Cloudflare AI", color: "#f38020", vendor: "Cloudflare", glyph: "C" },
    opencode: { name: "OpenCode", color: "#3f6070", vendor: "open source", glyph: "O" },
    deepseek: { name: "DeepSeek", color: "#3d7bd8", vendor: "DeepSeek", glyph: "D" },
  };
  const provMeta = (key) => PROVIDERS[key] || { name: key || "—", color: "#6a8794", vendor: "", glyph: (key || "?").slice(0, 1).toUpperCase() };
  const provName = (key) => provMeta(key).name;
  const provColor = (key) => provMeta(key).color;

  const CTX_COLOR = {
    messages: "#0f1a15",
    free_space: "#d8d2c2",
    auto_compact: "#8aa0a9",
    system_tools: "#ff4b2b",
    skills: "#c8f169",
    system_prompt: "#5f6f68",
  };
  const ctxColor = (name) => CTX_COLOR[name] || "#8aa0a9";

  /* Manuais da frota. Fatos de uso vêm do snapshot; aqui ficam finalidade,
     limites e alavancas de administração + documentação oficial verificada. */
  const KNOWLEDGE = {
    codex: {
      tag: "Agente de código",
      purpose: "Agente da OpenAI que lê o repositório, edita arquivos, executa comandos e testes. É a escolha natural para trabalho de engenharia com ferramentas, não apenas para responder perguntas.",
      best: ["Implementar e refatorar em repositórios reais", "Tarefas longas com testes e iteração", "Trabalho em lote com contexto de projeto"],
      avoid: ["Perguntas curtas que não precisam de ferramentas", "Sessões gigantes sem reutilizar cache", "Tarefas de volume massivo com contexto enorme"],
      manage: ["Acompanhe a janela semanal e a janela de 5h antes de picos", "Reutilize a mesma sessão para aproveitar cache de prompt", "Use verbosity/reasoning baixos na rotina", "Desative plugins e MCP que não usa: eles entram no input fixo", "Você tem 2 reset credits disponíveis"],
      docs: [["Documentação Codex", "https://developers.openai.com/codex/"], ["Platform docs", "https://platform.openai.com/docs"]],
      verdict: "Código com ferramentas. Para rotina use modelos rápidos; reserve os modelos maiores para arquitetura e depuração difícil.",
    },
    claude: {
      tag: "Raciocínio e contexto longo",
      purpose: "Modelos da Anthropic com foco em escrita, análise, raciocínio cuidadoso e janelas de contexto longas. Também atua como agente de código via Claude Code.",
      best: ["Textos longos, análise e revisão crítica", "Contextos grandes com muitos documentos", "Trabalho que exige nuance e justificativa"],
      avoid: ["Volume barato de classificação simples", "Tarefas que dependem de créditos premium sem saldo", "Pedidos repetitivos sem cache"],
      manage: ["Existem janelas de sessão e semanal; acompanhe as duas", "Modelos premium exigem créditos extras nesta conexão", "Use prompt caching para documentos repetidos", "Reduza anexos e histórico quando o contexto não for essencial"],
      docs: [["Claude docs", "https://docs.claude.com/"], ["Claude Code", "https://code.claude.com/docs/"], ["Suporte e planos", "https://support.anthropic.com/"]],
      verdict: "Qualidade de raciocínio e contexto. Use quando a resposta precisa ser pensada; evite para volume descartável.",
    },
    antigravity: {
      tag: "IDE agêntica",
      purpose: "Ambiente agêntico do Google com modelos Gemini, voltado a planejar e executar mudanças em projetos com supervisão humana.",
      best: ["Explorar e alterar projetos com planejamento", "Tarefas multimodais com imagens e UI", "Trabalho assistido em janelas grandes"],
      avoid: ["Tarefas isoladas de terminal", "Fluxos que exigem um modelo específico não exposto"],
      manage: ["A cota é por modelo e por conta; escolha o modelo certo", "Aproveite cache de contexto em projetos longos", "Evite reenviar arquivos inteiros quando um trecho basta"],
      docs: [["Antigravity docs", "https://antigravity.google/docs"], ["Gemini API", "https://ai.google.dev/gemini-api/docs"]],
      verdict: "Projetos multimodais e mudanças planejadas no Google. Ótimo para UI, imagens e contexto grande.",
    },
    "gemini-cli": {
      tag: "CLI do Gemini",
      purpose: "Interface de linha de comando do Gemini para tarefas rápidas, scripts e automação no terminal.",
      best: ["Perguntas e transformações rápidas", "Automação de terminal", "Modelos Gemini com contexto grande"],
      avoid: ["Trabalho que exige edição sofisticada de repositório", "Fluxos com ferramentas proprietárias de outra IDE"],
      manage: ["A cota segue a conta Google e o modelo escolhido", "Prefira modelos flash para volume", "Use cache de contexto em sessões longas"],
      docs: [["Gemini API", "https://ai.google.dev/gemini-api/docs"], ["Antigravity docs", "https://antigravity.google/docs"]],
      verdict: "Velocidade no terminal. Bom para tarefas curtas e automação; para repo grande, prefira um agente dedicado.",
    },
    gemini: {
      tag: "Multimodal",
      purpose: "Modelos Gemini via API, com força em multimodalidade, contexto longo e custo agressivo nos modelos flash.",
      best: ["Imagens, PDFs e vídeo", "Contextos muito longos", "Volume com modelo flash"],
      avoid: ["Tarefas que exigem sigilo absoluto na nuvem", "Raciocínio profundo sem testar o modelo maior"],
      manage: ["Escolha flash para volume e pro para raciocínio", "Cobre por token; monitore grounding e mídia", "Use cache de contexto quando repetir documentos"],
      docs: [["Gemini API", "https://ai.google.dev/gemini-api/docs"]],
      verdict: "Multimodal e contexto longo com bom custo. Ideal para documentos, imagens e análise em escala.",
    },
    openrouter: {
      tag: "Roteador multi-modelo",
      purpose: "Gateway que expõe centenas de modelos com uma única API, créditos e políticas de roteamento/fallback.",
      best: ["Comparar modelos com a mesma interface", "Fallback entre provedores", "Modelos grátis para experimentos"],
      avoid: ["Quando você precisa do recurso exclusivo de um provedor", "Rotas sem limite de gasto"],
      manage: ["Defina limites de crédito e acompanhe o consumo por modelo", "Use variantes :free para testes", "Configure fallback e ordem de provedores", "Cuidado com modelos marcados como beta"],
      docs: [["OpenRouter docs", "https://openrouter.ai/docs"], ["FAQ e limites", "https://openrouter.ai/docs/faq"]],
      verdict: "Flexibilidade e fallback. Use como camada de roteamento; para o melhor de um provedor, conecte-o direto.",
    },
    nvidia: {
      tag: "Modelos abertos acelerados",
      purpose: "Catálogo NIM da NVIDIA com modelos abertos otimizados, útil para experimentação e volume sem custo por token no plano atual.",
      best: ["Volume e experimentos com custo zero", "Modelos abertos como Nemotron", "Testes de qualidade antes de migrar"],
      avoid: ["Dados que não podem sair da máquina", "Disponibilidade crítica sem fallback"],
      manage: ["Acompanhe rate limits e modelos aposentados", "Mantenha fallback para outro provedor", "Atualize o catálogo: modelos EOL param de responder", "Não use como único caminho para produção"],
      docs: [["NVIDIA NIM", "https://docs.nvidia.com/nim/"], ["Build NVIDIA", "https://build.nvidia.com/"]],
      verdict: "Custo zero para volume e testes. Excelente segunda rota; não confie como rota única.",
    },
    ollama: {
      tag: "Modelos locais",
      purpose: "Executa modelos abertos na sua máquina. Nada sai do computador; o limite é hardware, não cota de nuvem.",
      best: ["Privacidade total", "Trabalho offline", "Testes de modelos e embeddings locais"],
      avoid: ["Modelos grandes sem VRAM suficiente", "Tarefas que exigem o estado da arte em código"],
      manage: ["Escolha tamanho/quantização conforme RAM e VRAM", "Ajuste keep_alive para liberar memória", "Atualize modelos EOL: o combo atual ainda aponta para um aposentado", "Um modelo por vez evita swap"],
      docs: [["Biblioteca Ollama", "https://ollama.com/library"], ["Documentação", "https://docs.ollama.com/"]],
      verdict: "Privacidade e offline. Use para dados sensíveis e experimentos locais; aceite menos capacidade.",
    },
    "cloudflare-ai": {
      tag: "Inferência na borda",
      purpose: "Workers AI roda modelos na rede da Cloudflare, com cobrança por neurônios e integração a Workers.",
      best: ["APIs de baixa latência na borda", "Tarefas leves integradas a Workers", "Embeddings e classificação"],
      avoid: ["Modelos de fronteira para código complexo", "Contas sem account ID correto"],
      manage: ["A cobrança é por neurônios; monitore por modelo", "Cache respostas repetidas", "Valide o account ID antes de habilitar no combo"],
      docs: [["Workers AI docs", "https://developers.cloudflare.com/workers-ai/"]],
      verdict: "Latência de borda e integração serverless. Melhor para tarefas leves, não para código pesado.",
    },
    opencode: {
      tag: "Agente open source",
      purpose: "Agente de código open source que usa o provedor/modelo que você conectar, com foco em terminal e fluxo aberto.",
      best: ["Fluxos de código abertos e customizáveis", "Usar seu próprio provedor", "Automação no terminal"],
      avoid: ["Quando você precisa de suporte proprietário", "Modelos fora do catálogo configurado"],
      manage: ["Defina o modelo padrão e o fallback", "Atualize o catálogo quando um modelo sumir", "Limite o contexto enviado por tarefa"],
      docs: [["OpenCode docs", "https://opencode.ai/docs/"]],
      verdict: "Customização e abertura. Bom quando você quer controle do agente e do provedor.",
    },
  };

  const knowledgeFor = (key) => KNOWLEDGE[key] || null;

  /* ---------------------------------------------------------- state */

  const app = $("#app");
  const stage = $("#stage");
  const holder = $("#holder");

  const detectLang = () => {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "pt-BR";
    const code = String(nav).slice(0, 2).toLowerCase();
    return I18N && I18N.has(code) ? code : "pt";
  };

  const normalizeBudgets = (raw) => {
    const src = raw && typeof raw === "object" ? raw : {};
    const providers = {};
    Object.entries(src.providers || {}).forEach(([key, value]) => {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) providers[key] = Math.round(n * 100) / 100;
    });
    const global = Number(src.global);
    const threshold = Number(src.threshold);
    return {
      global: Number.isFinite(global) && global > 0 ? Math.round(global * 100) / 100 : null,
      providers,
      threshold: [50, 60, 70, 80, 90].includes(threshold) ? threshold : 80,
    };
  };

  const state = {
    snap: null,
    lang: I18N && I18N.has(store.get("lang", detectLang())) ? store.get("lang", detectLang()) : "pt",
    currency: ["BRL", "USD", "EUR"].includes(store.get("currency", "BRL")) ? store.get("currency", "BRL") : "BRL",
    rates: { USD: 5.42, EUR: 5.86, ...(store.get("rates", {}) || {}) },
    loadedAt: 0,
    mode: "today",
    selectedDay: null,
    focus: "",
    tab: "agora",
    wing: null,
    sunStates: [],
    sunIndex: 0,
    sunPaused: false,
    chartItems: [],
    bucketKind: "hours",
    quests: [],
    doneSet: new Set(),
    reviewed: new Set(store.get("reviewed", [])),
    visited: new Set(store.get("visited", [])),
    votes: store.get("votes", {}),
    palette: [],
    paletteIndex: 0,
    tourStep: 0,
    chat: [],
    chatBusy: false,
    sessionQuery: "",
    sessionSort: "context",
    projectionDays: 7,
    manualTask: "code",
    busy: false,
    ready: false,
    pipIndex: 0,
    lastTipAt: 0,
    settingsOpen: false,
    budgetOpen: false,
    budgets: normalizeBudgets(store.get("budgets", {})),
    security: null,
    securityLoading: false,
    operator: store.get("operator", ""),
    port: { cx: 600, cy: 540, k: 1, selected: null, movedAt: 0 },
    manualStep: 0,
    manualReturn: null,
    probes: {},
    probingAll: false,
  };

  // A base de custo passou de "BRL presumido" para USD, como o 9router grava.
  // Orçamentos antigos são convertidos uma única vez para manter o mesmo valor exibido.
  if (store.get("costBase") !== "USD") {
    if (state.budgets.global || Object.keys(state.budgets.providers).length) {
      const brl = ratePerUsd("BRL");
      const providers = {};
      Object.entries(state.budgets.providers).forEach(([key, value]) => {
        providers[key] = Math.round((value / brl) * 100) / 100;
      });
      state.budgets = normalizeBudgets({
        ...state.budgets,
        global: state.budgets.global ? state.budgets.global / brl : null,
        providers,
      });
      store.set("budgets", state.budgets);
      state.pendingBudgets = true;
    }
    store.set("costBase", "USD");
  }

  const railIcon = (key) => {
    const svg = document.querySelector(`.rail-btn[data-wing="${key}"] svg`);
    return svg ? svg.outerHTML : "";
  };

  const WINGS = {
    atlas: { eyebrow: "PORTO", title: "Atlas", sub: "O mapa vivo da sua operação de IA." },
    fluxo: { eyebrow: "ALA 01", title: "Fluxo", sub: "Consumo, projeção e orçamento em uma linha do tempo viva." },
    sessoes: { eyebrow: "ALA 02", title: "Sessões", sub: "Cada chamada, cada projeto, cada contexto — com diagnóstico." },
    oficina: { eyebrow: "ALA 03", title: "Oficina", sub: "Skills, artefatos e o desperdício que ninguém vê." },
    oraculo: { eyebrow: "ALA 04", title: "Oráculo", sub: "O assistente local que lê seus números e propõe ações." },
    biblioteca: { eyebrow: "ALA 05", title: "Biblioteca", sub: "O manual da frota: para que serve cada IA e como domar o consumo." },
    diario: { eyebrow: "ALA 06", title: "Diário", sub: "Changelog, conquistas e a memória da sua operação." },
    guilda: { eyebrow: "ALA 07", title: "Guilda", sub: "Comunidade, roadmap e o próximo passo do Rune." },
    perfil: { eyebrow: "ALA 08", title: "Perfil", sub: "Conexões, fontes locais, chaves mascaradas e privacidade." },
    ajuda: { eyebrow: "ALA 09", title: "Ajuda", sub: "Transforme erro em correção com um prompt pronto." },
  };

  const WING_ORDER = ["fluxo", "sessoes", "oficina", "oraculo", "biblioteca", "diario", "guilda", "perfil", "ajuda"];

  /* ---------------------------------------------------------- boot */

  function boot() {
    scaleStage();
    applyUiScale();
    initStars();
    initSceneFx();
    initParallax();
    initFleetTilt();
    bindChrome();
    bindDelegates();
    bindKeyboard();
    initPortCamera();
    initTour();
    applyShellTranslations();
    loadSnapshot();
    startClocks();
  }

  function applyUiScale(retry = 0) {
    // Base de 1280x720. O zoom do CSS é ignorado por vários navegadores de TV,
    // então a escala é feita com transform no shell — funciona em qualquer motor.
    // As medidas vão em px prontos: navegadores de TV antigos não sabem dividir
    // dentro de calc(), e a página ficaria minúscula.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Alguns navegadores de TV devolvem 0 antes do primeiro layout.
    if (!vw || !vh) {
      if (retry < 20) setTimeout(() => applyUiScale(retry + 1), 100);
      return;
    }
    const fit = Math.min(vw / 1280, vh / 720);
    const scale = Math.max(1, Math.min(3, fit));
    const scaled = scale > 1.001;
    const root = document.documentElement;
    const holder = document.querySelector(".holder");
    root.style.setProperty("--ui-scale", scale.toFixed(4));
    root.style.setProperty("--ui-w", `${(vw / scale).toFixed(2)}px`);
    root.style.setProperty("--ui-h", `${(vh / scale).toFixed(2)}px`);
    if (root.classList && root.classList.toggle) root.classList.toggle("ui-scaled", scaled);
    // Estilos diretos no shell como segunda via: TVs antigas não aplicam
    // custom properties dentro de transform/width, e aí a página ficava pequena.
    if (holder) {
      if (scaled) {
        holder.style.width = `${(vw / scale).toFixed(2)}px`;
        holder.style.height = `${(vh / scale).toFixed(2)}px`;
        holder.style.transform = `scale(${scale.toFixed(4)})`;
        holder.style.transformOrigin = "top left";
        holder.style.overflow = "hidden";
      } else {
        holder.style.width = "";
        holder.style.height = "";
        holder.style.transform = "";
        holder.style.transformOrigin = "";
        holder.style.overflow = "";
      }
    }
    root.style.zoom = "";
    if (window.requestAnimationFrame) requestAnimationFrame(() => applyPortCamera());
    else setTimeout(applyPortCamera, 32);
  }

  function scaleStage() {
    stage.style.transform = "none";
    // Em TV/monitor grande o holder é dimensionado pelo applyUiScale; não sobrescrever.
    if (document.documentElement.classList.contains("ui-scaled")) return;
    holder.style.width = "100%";
    holder.style.height = "auto";
  }

  async function pushSettings(payload) {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadSnapshot() {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applySnapshot(data);
    } catch (err) {
      console.error("Rune snapshot:", err);
      $("#liveLabel").textContent = "offline";
      $("#livePill").classList.add("stale");
      $("#chartSub").textContent = tr("common.localError");
      toast(`Servidor local não respondeu · ${err.message}`, "bad");
    }
  }

  function applySnapshot(data, opts = {}) {
    if (!data || !data.meta) throw new Error("snapshot inválido");
    const first = !state.snap;
    state.snap = data;
    hydrateProbes(data.fleet?.routes);
    state.loadedAt = Date.now();
    if (!state.selectedDay || !data.series?.some((d) => d.date === state.selectedDay)) {
      state.selectedDay = data.today?.date || data.series?.[data.series.length - 1]?.date || null;
    }
    state.sunStates = Array.isArray(data.sunStates) ? data.sunStates : [];
    state.sunIndex = Math.min(state.sunIndex, Math.max(0, state.sunStates.length - 1));

    const serverBudgets = data.settings?.budgets;
    if (serverBudgets) {
      const hasServer = Boolean(serverBudgets.global) || Object.keys(serverBudgets.providers || {}).length > 0;
      const hasLocal = Boolean(state.budgets.global) || Object.keys(state.budgets.providers).length > 0;
      if (!hasServer && hasLocal && state.pendingBudgets) {
        state.pendingBudgets = false;
        pushSettings({ budgets: state.budgets }).catch(() => { state.pendingBudgets = true; });
      } else {
        state.budgets = normalizeBudgets(serverBudgets);
        store.set("budgets", state.budgets);
      }
    }

    renderTopbar();
    renderSun();
    renderHero();
    renderToday();
    renderFleet();
    renderTimeline();
    renderChart();
    renderQuests();
    renderXP();
    renderCockpit();
    renderBand();
    renderTicker();
    renderPipTip();
    renderPort();
    if (state.wing) renderWing(state.wing, { preserve: true });

    if (first) {
      state.doneSet = new Set(state.quests.filter((q) => q.done).map((q) => q.id));
      state.ready = true;
      if (!store.get("tourSeen", false) && !location.search.includes("notour")) {
        setTimeout(() => { if (!state.wing && $("#drawer").hidden && $("#manual").hidden) openManual(0); }, 1300);
      }
    }
  }

  /* ---------------------------------------------------------- scene */

  function initStars() {
    const stars = $("#stars");
    if (!stars || stars.childElementCount) return;
    let html = "";
    for (let i = 0; i < 74; i++) {
      const x = (Math.random() * 100).toFixed(2);
      const y = (Math.random() * 62).toFixed(2);
      const delay = (Math.random() * 6).toFixed(2);
      const size = Math.random() > 0.82 ? 2.6 : 2;
      html += `<i class="star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;animation-delay:${delay}s"></i>`;
    }
    stars.innerHTML = html;
  }

  function initSceneFx() {
    const canvas = $("#sceneFx");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = 1440 * dpr;
    canvas.height = 900 * dpr;
    ctx.scale(dpr, dpr);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const parts = Array.from({ length: 42 }, () => ({
      x: Math.random() * 1440,
      y: Math.random() * 900,
      vx: (Math.random() - 0.5) * 0.16,
      vy: 0.05 + Math.random() * 0.22,
      r: 0.7 + Math.random() * 1.8,
      a: 0.12 + Math.random() * 0.26,
      p: Math.random() * Math.PI * 2,
    }));
    if (reduce) return;
    let t = 0;
    const frame = () => {
      t += 0.016;
      ctx.clearRect(0, 0, 1440, 900);
      const dusk = app.dataset.light === "dusk";
      parts.forEach((p) => {
        p.x += p.vx + Math.sin(t * 0.5 + p.p) * 0.06;
        p.y += p.vy;
        if (p.y > 910) { p.y = -10; p.x = Math.random() * 1440; }
        if (p.x < -10) p.x = 1450;
        if (p.x > 1450) p.x = -10;
        const alpha = p.a * (0.7 + 0.3 * Math.sin(t + p.p));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (dusk) {
          ctx.fillStyle = `rgba(255, 231, 150, ${alpha * 1.4})`;
          ctx.shadowColor = "rgba(255, 226, 128, .8)";
          ctx.shadowBlur = 8;
        } else {
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.shadowColor = "rgba(255, 255, 255, .6)";
          ctx.shadowBlur = 4;
        }
        ctx.fill();
      });
      ctx.shadowBlur = 0;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function initParallax() {
    let tx = 0, ty = 0, cx = 0, cy = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    app.addEventListener("pointermove", (e) => {
      const r = app.getBoundingClientRect();
      tx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
      ty = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
    });
    const loop = () => {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      app.style.setProperty("--px", cx.toFixed(4));
      app.style.setProperty("--py", cy.toFixed(4));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function initFleetTilt() {
    const fleet = $("#fleet");
    if (!fleet || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const reset = (except) => fleet.querySelectorAll(".plot").forEach((p) => {
      if (p === except) return;
      p.style.setProperty("--rx", "0deg");
      p.style.setProperty("--ry", "0deg");
    });
    fleet.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".provider");
      const plot = card?.querySelector(".plot");
      if (!plot) return;
      const r = plot.getBoundingClientRect();
      const dx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
      const dy = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
      plot.style.setProperty("--ry", `${(dx * 9).toFixed(2)}deg`);
      plot.style.setProperty("--rx", `${(-dy * 7).toFixed(2)}deg`);
      reset(plot);
    });
    fleet.addEventListener("pointerleave", () => reset(null));
  }

  /* ---------------------------------------------------------- topbar + hero */

  function renderTopbar() {
    const S = state.snap;
    const meta = S.meta;
    $("#crumbRoot").textContent = meta.host || "Rune";
    $("#heroPill").innerHTML = `<i class="dot-live"></i> ${esc(longDate(meta.now))} · ${esc(tr("common.localMode"))}`;
    $("#streakVal").textContent = S.totals.activeDays;
    $("#streak").title = `${S.totals.activeDays} · ${tr("common.days")}`;
    $("#chipLiveText").textContent = tr("hero.collectAgo", { ago: ago(meta.router_age) });
    $("#chipProviders").textContent = tr("hero.providersMeasuring", { n: S.providers.length });
    $("#liveLabel").textContent = tr("common.live");
    $("#livePill").classList.toggle("stale", meta.router_age > 1800);
    $("#livePill").classList.toggle("busy", state.busy);
    $("#cockpitLive").textContent = state.busy ? tr("common.collecting") : tr("common.live");
    updateAgeLabels();
  }

  function renderHero() {
    const S = state.snap;
    const q = S.quota?.codex;
    const weekFree = q?.available ? q.week_free : null;
    const bad = (S.alerts || []).filter((a) => a.tone === "bad").length;
    const warn = (S.alerts || []).filter((a) => a.tone === "warn").length;
    const sky = bad
      ? tr(bad === 1 ? "hero.skyBadOne" : "hero.skyBad", { n: bad })
      : warn
        ? tr(warn === 1 ? "hero.skyWarnOne" : "hero.skyWarn", { n: warn })
        : tr("hero.skyClear");
    const pace = q?.pace != null && q?.target != null ? tr(q.pace < q.target ? "hero.paceUnder" : "hero.paceOver") : "";
    const folga = weekFree != null
      ? tr("hero.folga", { pct: pct(weekFree), pace })
      : tr("hero.folgaNone");
    const todayLine = tr("hero.today", {
      tokens: compact(S.today.tokens),
      calls: int(S.today.requests),
      cost: money(S.today.cost),
    });
    $("#heroTitle").innerHTML = `<span class="h1-greet">${greeting()},</span><span class="h1-name">${esc(operatorName())}<i>.</i><svg class="hero-scrawl" viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true"><path d="M4 13C56 5 116 4 167 8c41 3 82 4 129 1"/><path d="M12 17c47-5 103-7 148-4 31 2 60 2 88 1"/></svg></span>`;
    $("#heroText").innerHTML = `${sky} ${folga} ${todayLine}`;
    $("#chipXpText").textContent = tr("hero.xp", { n: xpToday() });
    $("#chipLive").title = tr("topbar.lastRead", { ago: ago(S.meta.router_age) });
    $("#chipProviders").title = S.providers.map((p) => `${provName(p.provider)} · ${pct(p.share)}`).join(" · ");
    const nowD = dateObj(S.meta.now) || new Date();
    const jan1 = new Date(nowD.getFullYear(), 0, 1);
    const week = Math.ceil(((nowD - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    $("#heroIssue").textContent = `Nº ${String(week).padStart(3, "0")}`;
    $("#heroDate").textContent = longDate(nowD);
  }

  const operatorName = () => state.operator || state.snap?.meta?.operator || tr("perfil.operatorFallback");

  function xpToday() {
    const completed = state.quests.filter((q) => q.done).reduce((sum, q) => sum + q.xp, 0);
    return completed + Math.min(2, state.reviewed.size) * 10;
  }

  function setNum(el, value, format, duration = 620) {
    if (!el) return;
    const target = Number(value) || 0;
    const from = Number(el.dataset.v || 0);
    el.dataset.v = target;
    if (Math.abs(target - from) < 0.01 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.innerHTML = format(target);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.innerHTML = format(from + (target - from) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderToday() {
    const S = state.snap;
    const today = S.today;
    $("#tcLabel").textContent = tr("today.tokens", { label: tr("common.today") });
    setNum($("#tcTokens"), today.tokens, (v) => `${compact(v)}<small>${tr("common.tokens")}</small>`);
    setNum($("#tcCost"), today.cost, (v) => money(v), 500);
    setNum($("#tcReqs"), today.requests, (v) => int(v), 500);
    $("#tcCache").textContent = pct(S.totals.cacheHit);
    const stampDate = dateObj(S.today.date);
    const stampEl = $("#tcStamp");
    if (stampEl && stampDate) stampEl.textContent = `${String(stampDate.getDate()).padStart(2, "0")} ${monthShort(stampDate).toUpperCase()}`;
    const week = (S.series || []).slice(-7);
    const weekMax = Math.max(1, ...week.map((d) => d.tokens));
    const weekTotal = week.reduce((sum, d) => sum + d.tokens, 0);
    const weekEl = $("#tcWeek");
    if (weekEl) weekEl.textContent = `${compact(weekTotal)} tokens`;
    const sparkEl = $("#tcSpark");
    if (sparkEl) {
      sparkEl.innerHTML = week.map((d) => `<i class="${d.date === S.today.date ? "on" : ""}" style="height:${Math.max(6, (Math.log10((d.tokens || 0) + 1) / Math.log10(weekMax + 1)) * 100).toFixed(1)}%" title="${esc(longDate(d.date))} · ${compact(d.tokens)} tokens"></i>`).join("");
    }
    const top = S.insights?.topModel;
    $("#tcModel").textContent = top ? modelName(top.model) : "—";
    $("#tcModel").title = top ? `${top.model} · ${provName(top.provider)}` : "";
    const delta = Number(S.insights?.todayVsPrev);
    const chip = $("#tcDelta");
    if (Number.isFinite(delta)) {
      chip.classList.toggle("down", delta < 0);
      chip.textContent = tr("today.vsYesterday", { arrow: delta > 0 ? "▲" : "▼", pct: pct(Math.abs(delta), 0) });
      chip.title = tr("today.deltaTitle");
    } else {
      chip.textContent = "—";
    }
  }

  /* ---------------------------------------------------------- sun */

  function renderSun() {
    const states = state.sunStates;
    if (!states.length) return;
    const s = states[state.sunIndex % states.length];
    const ring = $("#ringFill");
    const pctValue = clamp(s.pct, 0, 100);
    if (ring) {
      const C = 2 * Math.PI * 82;
      ring.style.strokeDasharray = `${(C * pctValue) / 100} ${C}`;
      ring.style.stroke = s.provider === "claude" ? "#d97757" : s.key.includes("session") ? "#37a6c8" : "#2f9e6b";
    }
    const codexQ = state.snap?.quota?.codex;
    let eyebrow = s.eyebrow;
    let sub = s.sub;
    let tag = s.tag;
    if (s.key === "codex-week") {
      eyebrow = `${tr("sun.headroom")} · CODEX ${tr("sun.week")}`;
      sub = until(s.reset);
      if (codexQ?.available) tag = tr("sun.pace", { pace: pct(codexQ.pace), target: pct(codexQ.target) });
    } else if (s.key === "codex-session") {
      eyebrow = `${tr("sun.headroom")} · ${tr("sun.window5h")}`;
      sub = until(s.reset);
      tag = tr("sun.shortUse", { pct: pct(100 - pctValue, 0) });
    } else if (s.key === "claude-week") {
      eyebrow = `${tr("sun.headroom")} · CLAUDE ${tr("sun.week")}`;
      sub = until(s.reset);
      tag = tr("sun.claudeTag");
    }
    $("#sunEyebrow").textContent = eyebrow;
    $("#sunPct").innerHTML = `${Math.round(pctValue)}<span>%</span>`;
    $("#sunSub").textContent = sub;
    $("#sunTag").textContent = tag;
    const wrap = $("#sunGauge");
    const fill = $("#qsFill");
    if (fill) fill.style.width = `${pctValue}%`;
    wrap.dataset.tone = pctValue < 20 ? "bad" : pctValue < 45 ? "warn" : "ok";
    wrap.setAttribute("aria-label", tr("atlas.sunAria", { eyebrow, pct: Math.round(pctValue), tag }));
    wrap.title = `${eyebrow} · ${tag} · ${tr("common.resetIn", { v: until(s.reset) })}`;
    let dots = $(".sun-dots", wrap);
    if (!dots) {
      dots = document.createElement("div");
      dots.className = "sun-dots";
      wrap.appendChild(dots);
    }
    dots.innerHTML = states.map((x, i) => `<i class="sun-dot${i === state.sunIndex % states.length ? " on" : ""}"></i>`).join("");
  }

  function nextSun(manual = false) {
    if (!state.sunStates.length) return;
    state.sunIndex = (state.sunIndex + 1) % state.sunStates.length;
    renderSun();
    if (manual) {
      const wrap = $("#sunGauge");
      wrap.classList.remove("bump");
      void wrap.offsetWidth;
      wrap.classList.add("bump");
    }
  }

  /* ---------------------------------------------------------- fleet */

  const BUILDING_KIND = {
    codex: "tower", claude: "archive", antigravity: "dome", "gemini-cli": "dome", gemini: "dome",
    openrouter: "relay", nvidia: "stack", ollama: "stack", "cloudflare-ai": "stack",
    opencode: "tower", deepseek: "tower",
  };

  function mixHex(hex, target, f) {
    const h = String(hex || "#6a8794").replace("#", "");
    const t = target.replace("#", "");
    const a = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
    const b = [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16) || 0);
    return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * f).toString(16).padStart(2, "0")).join("");
  }

  function buildingSvg(provider, color) {
    const kind = BUILDING_KIND[provider] || "tower";
    const top = mixHex(color, "#FFFFFF", .46);
    const left = mixHex(color, "#FFFFFF", .14);
    const right = mixHex(color, "#0F1A15", .28);
    const ink = "#12201C";
    const glass = "#FFF4CE";
    const red = "#FF4B2B";
    const s = `stroke="${ink}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"`;
    const shadow = `<ellipse cx="60" cy="82" rx="33" ry="5.4" fill="${ink}" opacity=".13"/>`;
    const ground = `<path d="M20 79h80" stroke="${ink}" stroke-width="1" opacity=".32"/>`;

    if (kind === "archive") {
      return `<svg class="building" viewBox="0 0 120 92" fill="none" aria-hidden="true">${shadow}
        <path d="M28 58v12l32 12 32-12V58L60 46z" fill="${left}" ${s}/>
        <path d="M60 70v12l32-12V58z" fill="${right}" ${s}/>
        <path d="M28 58l32 12 32-12-32-12z" fill="${top}" ${s}/>
        <path d="M28 52l32-12 32 12" fill="none" stroke="${ink}" stroke-width="1" opacity=".45"/>
        <path d="M66 75v-5a3.2 3.2 0 016.4 0v5zM75 71.6v-5a3.2 3.2 0 016.4 0v5z" fill="${glass}" opacity=".9" stroke="${ink}" stroke-width=".8"/>
        <path d="M38 68v4M44 70.5v4" stroke="${ink}" stroke-width="1.2" opacity=".5"/>
        <path d="M60 46V34M54 38h12" stroke="${ink}" stroke-width="1.2"/>
        <circle cx="60" cy="33" r="2" fill="${red}"/>
        ${ground}
      </svg>`;
    }

    if (kind === "dome") {
      return `<svg class="building" viewBox="0 0 120 92" fill="none" aria-hidden="true">${shadow}
        <path d="M32 64v9a28 7 0 0056 0v-9" fill="${left}" ${s}/>
        <ellipse cx="60" cy="64" rx="28" ry="7" fill="${top}" ${s}/>
        <path d="M42 64a18 18 0 0136 0z" fill="${left}" ${s}/>
        <path d="M42 64a18 18 0 0136 0" fill="none" stroke="${ink}" stroke-width="1.3"/>
        <path d="M60 46v18M48 49.5c4 4.6 6 9.3 6 14.5M72 49.5c-4 4.6-6 9.3-6 14.5" stroke="${ink}" stroke-width=".9" opacity=".45"/>
        <path d="M52 73v-5a4 4 0 018 0v5zM66 73v-5a4 4 0 018 0v5z" fill="${glass}" opacity=".9" stroke="${ink}" stroke-width=".8"/>
        <path d="M60 46V36" stroke="${ink}" stroke-width="1.2"/>
        <circle cx="60" cy="35" r="2.2" fill="${red}"/>
        ${ground}
      </svg>`;
    }

    if (kind === "relay") {
      return `<svg class="building" viewBox="0 0 120 92" fill="none" aria-hidden="true">${shadow}
        <path d="M40 78V66l20-9 20 9v12l-20 8z" fill="${left}" ${s}/>
        <path d="M60 74v8l20-8V66z" fill="${right}" ${s}/>
        <path d="M40 66l20 8 20-9-20-8z" fill="${top}" ${s}/>
        <path d="M60 62V18M50 30h20M48 44h24M54 18l12 26M66 18L54 44" stroke="${ink}" stroke-width="1.2"/>
        <path d="M45 24a21 21 0 0130 0M49 31a15 15 0 0122 0" stroke="${red}" stroke-width="1.4" opacity=".85"/>
        <circle cx="60" cy="16" r="2.6" fill="${red}"/>
        <path d="M52 72h16" stroke="${ink}" stroke-width="1" opacity=".45"/>
        ${ground}
      </svg>`;
    }

    if (kind === "stack") {
      return `<svg class="building" viewBox="0 0 120 92" fill="none" aria-hidden="true">${shadow}
        <path d="M32 76V64l28-12 28 12v12l-28 11z" fill="${left}" ${s}/>
        <path d="M60 75v12l28-11V64z" fill="${right}" ${s}/>
        <path d="M32 64l28 11 28-12-28-11z" fill="${top}" ${s}/>
        <path d="M38 56V46l22-9 22 9v10l-22 9z" fill="${left}" ${s}/>
        <path d="M60 55v9l22-9V45z" fill="${right}" ${s}/>
        <path d="M38 46l22 9 22-9-22-9z" fill="${top}" ${s}/>
        <path d="M46 38V30l14-6 14 6v8l-14 6z" fill="${left}" ${s}/>
        <path d="M60 37v7l14-6v-8z" fill="${right}" ${s}/>
        <path d="M46 30l14 7 14-7-14-6z" fill="${top}" ${s}/>
        <path d="M52 68h4M68 68h4M50 50h3M68 50h3" stroke="${glass}" stroke-width="1.6" opacity=".8"/>
        <circle cx="60" cy="21" r="2" fill="${red}"/>
        ${ground}
      </svg>`;
    }

    return `<svg class="building" viewBox="0 0 120 92" fill="none" aria-hidden="true">${shadow}
      <path d="M44 78V36l16-8 16 8v42z" fill="${left}" ${s}/>
      <path d="M60 44v42l16-8V36z" fill="${right}" ${s}/>
      <path d="M44 36l16 8 16-8-16-8z" fill="${top}" ${s}/>
      <path d="M64 48l7-3.5v6L64 54zM64 59l7-3.5v6L64 65zM64 70l7-3.5v6L64 76z" fill="${glass}" opacity=".9" stroke="${ink}" stroke-width=".7"/>
      <path d="M47 50l6-3v5l-6 3zM47 61l6-3v5l-6 3z" fill="${right}" opacity=".35"/>
      <path d="M60 28V14" stroke="${ink}" stroke-width="1.2"/>
      <circle cx="60" cy="13" r="2.2" fill="${red}"/>
      <path d="M44 36v42M60 44v42" stroke="${ink}" stroke-width="1" opacity=".25"/>
      ${ground}
    </svg>`;
  }

  function sparkline(provider, color) {
    const days = (state.snap.series || []).slice(-14);
    const vals = days.map((d) => d.providers?.[provider]?.tokens || 0);
    const max = Math.max(1, ...vals);
    const W = 86, H = 14;
    const pts = vals.map((v, i) => [(i / Math.max(1, vals.length - 1)) * W, H - 2 - (v / max) * (H - 4)]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d} L${W} ${H} L0 ${H} Z" fill="${color}" opacity=".12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function renderFleet() {
    const S = state.snap;
    const rows = (S.providers || []).slice(0, 4);
    const fleet = $("#fleet");
    fleet.innerHTML = rows.map((p, idx) => {
      const meta = provMeta(p.provider);
      const active = state.focus === p.provider;
      const shareText = p.share < 10 ? pct(p.share, 1) : pct(p.share, 0);
      return `<button class="provider${active ? " active" : ""}" style="--pc:${meta.color}" data-act="provider" data-key="${esc(p.provider)}" title="${esc(meta.name)} · ${pct(p.share)} dos tokens · clique para filtrar e ver o manual" aria-pressed="${active}">
        <span class="plot" aria-hidden="true">
          <b class="plot-index">${String(idx + 1).padStart(2, "0")}</b>
          <b class="plot-share">${shareText.replace("%", "")}<small>%</small></b>
          <i class="plot-horizon"></i>
          ${buildingSvg(p.provider, meta.color)}
        </span>
        <span class="prov-main">
          <span class="prov-top"><span class="prov-name">${esc(meta.name)}</span><span class="prov-vendor">${esc(meta.vendor)}</span></span>
          <span class="prov-bar"><i style="width:${clamp(p.share)}%"></i></span>
          <span class="prov-meta"><span><b>${compact(p.tokens)}</b> tokens</span><span>${money(p.cost)}</span></span>
          <span class="prov-spark">${sparkline(p.provider, meta.color)}<em>14d</em></span>
        </span>
      </button>`;
    }).join("");
    fleet.classList.toggle("has-focus", Boolean(state.focus));
  }

  /* ---------------------------------------------------------- porto */

  const PORT_LAYOUT = {
    source: { x: 600, y: 432 },
    ai: [
      { x: 392, y: 320 },
      { x: 808, y: 320 },
      { x: 262, y: 522 },
      { x: 938, y: 522 },
    ],
    tool: [
      { x: 288, y: 806 },
      { x: 444, y: 826 },
      { x: 600, y: 834 },
      { x: 756, y: 826 },
      { x: 912, y: 806 },
    ],
  };

  function portProviders() {
    const rows = (state.snap?.providers || []).filter((p) => Number(p.tokens) > 0);
    return (rows.length ? rows : (state.snap?.providers || [])).slice(0, 4);
  }

  function portTools() {
    const inv = state.snap?.inventory || {};
    const hasCli = (name) => Boolean((inv.clis || []).find((c) => c.name === name)?.installed);
    return [
      { key: "qoder", name: "Qoder", kind: "app", installed: Boolean(inv.qoder?.installed), source: "Qoder Desktop", noteKey: "port.tool.qoderNote" },
      { key: "codex", name: "Codex CLI", kind: "cli", installed: Boolean(inv.codex?.installed) || hasCli("Codex CLI"), source: "9router", noteKey: "port.tool.codexNote" },
      { key: "claude-code", name: "Claude Code", kind: "cli", installed: hasCli("Claude Code"), source: "9router", noteKey: "port.tool.claudeNote" },
      { key: "gemini-cli", name: "Gemini CLI", kind: "cli", installed: hasCli("Gemini CLI"), source: "9router", noteKey: "port.tool.geminiNote" },
      { key: "opencode", name: "OpenCode", kind: "cli", installed: hasCli("OpenCode"), source: "9router", noteKey: "port.tool.opencodeNote" },
    ];
  }

  const portSelected = (kind, key) => state.port.selected?.kind === kind && state.port.selected?.key === key;

  function portIsoBox(w, d, h, color, opts = {}) {
    const ink = "#12201C";
    const top = mixHex(color, "#FFFFFF", .42);
    const left = mixHex(color, "#FFFFFF", .1);
    const right = mixHex(color, "#0F1A15", .26);
    const glass = "#FFF4CE";
    const detail = opts.detail !== false;
    let windows = "";
    if (opts.windows !== false) {
      const rows = opts.rows || [0.24, 0.5, 0.76];
      const shade = opts.shade || "#E9D9A6";
      rows.forEach((v, ri) => {
        const x = (w / 2) * (opts.cols || 0.56);
        const y = -h + d / 2 + v * h;
        windows += `<path class="port-win" style="animation-delay:${(ri * -1.7 + (opts.delay || 0)).toFixed(1)}s" d="M${x.toFixed(1)} ${y.toFixed(1)}l9 -4.4v7.2l-9 4.4z" fill="${glass}" opacity="${opts.glow ? .94 : .7}" stroke="${ink}" stroke-width=".6"/>`;
        windows += `<path class="port-win" style="animation-delay:${(ri * -1.9 + .6).toFixed(1)}s" d="M${(-w / 2 + 12).toFixed(1)} ${(y + 4).toFixed(1)}l8 -4v6.4l-8 4z" fill="${glass}" opacity=".34" stroke="${ink}" stroke-width=".5"/>`;
        // Janelas da face direita: sem elas a fachada sombreada fica chapada.
        [.3, .58].forEach((u, ci) => {
          const wx = u * w / 2;
          const wy = -h + d / 2 - (d / 2) * u + v * h;
          windows += `<path class="port-win" style="animation-delay:${(ri * -1.5 + ci * .7 + .3).toFixed(1)}s" d="M${wx.toFixed(1)} ${wy.toFixed(1)}l${(9 - u * 3).toFixed(1)} ${(-4.4 + u * 1.4).toFixed(1)}v7.2l${(-9 + u * 3).toFixed(1)} ${(4.4 - u * 1.4).toFixed(1)}z" fill="${opts.glow ? shade : glass}" opacity="${opts.glow ? .8 : .42}" stroke="${ink}" stroke-width=".5"/>`;
        });
        if (detail) {
          windows += `<path class="port-win" style="animation-delay:${(ri * -2.4 + 1.1).toFixed(1)}s" d="M${(x * .46).toFixed(1)} ${(y + 2.2).toFixed(1)}l7 -3.4v5.6l-7 3.4z" fill="${glass}" opacity=".6" stroke="${ink}" stroke-width=".5"/>`;
        }
        if (opts.dense) {
          windows += `<path class="port-win" style="animation-delay:${(ri * -1.3 + .4).toFixed(1)}s" d="M${(x * .18).toFixed(1)} ${(y + 2.8).toFixed(1)}l7 -3.4v5.6l-7 3.4z" fill="${glass}" opacity=".5" stroke="${ink}" stroke-width=".5"/>`;
        }
      });
    }
    const door = detail && h > 46
      ? `<path d="M${(w * .12).toFixed(1)} ${(d / 2 - w * .03).toFixed(1)}l${(w * .13).toFixed(1)} ${(-w * .065).toFixed(1)}v${(-h * .2).toFixed(1)}l${(-w * .13).toFixed(1)} ${(w * .065).toFixed(1)}z" fill="${ink}" opacity=".26"/>`
      : "";
    const roof = detail
      ? `<path d="M0 ${(-h - 7).toFixed(1)}l9 -4.5 9 4.5-9 4.5z" fill="${right}" stroke="${ink}" stroke-width=".9" stroke-linejoin="round"/>
         <path d="M${-w / 2} ${-h}L0 ${-h - d / 2}" stroke="#FFFFFF" stroke-width="1.1" opacity=".45"/>`
      : "";
    const plinth = detail
      ? `<path d="M${-w / 2} -5L0 ${(d / 2 - 5).toFixed(1)}L0 ${(d / 2).toFixed(1)}L${-w / 2} 0Z" fill="#E4D6B6" opacity=".5"/>
         <path d="M0 ${(d / 2 - 5).toFixed(1)}L${w / 2} -5L${w / 2} 0L0 ${(d / 2).toFixed(1)}Z" fill="#CBB894" opacity=".55"/>`
      : "";
    return `<g class="iso">
      <ellipse cx="${(-w * .18).toFixed(1)}" cy="${(d / 2 + 13).toFixed(1)}" rx="${(w * .9).toFixed(1)}" ry="${(d * .54).toFixed(1)}" fill="${ink}" opacity=".12"/>
      <ellipse cx="${(-w * .12).toFixed(1)}" cy="${(d / 2 + 7).toFixed(1)}" rx="${(w * .62).toFixed(1)}" ry="${(d * .36).toFixed(1)}" fill="${ink}" opacity=".2"/>
      <polygon points="${-w / 2},${-h} 0,${-h + d / 2} 0,${d / 2} ${-w / 2},0" fill="${left}" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>
      <polygon points="0,${-h + d / 2} ${w / 2},${-h} ${w / 2},0 0,${d / 2}" fill="${right}" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>
      <polygon points="0,${-h - d / 2} ${w / 2},${-h} 0,${-h + d / 2} ${-w / 2},${-h}" fill="${top}" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>
      ${roof}
      ${plinth}
      ${door}
      ${windows}
      ${opts.extra || ""}
    </g>`;
  }

  function portRoad(d, color, active) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const packets = active && !reduce
      ? [0, 1].map((n) => `<circle class="port-packet" r="3.6" fill="${color}" stroke="#12201C" stroke-width="1.1">
          <animateMotion dur="${3.4 + n * 1.2}s" begin="${(n * 1.4).toFixed(1)}s" repeatCount="indefinite" path="${d}"/>
        </circle>`).join("")
      : "";
    return `<path class="port-road-edge" d="${d}"/>
      <path class="port-road-base" d="${d}"/>
      <path class="port-road-line" d="${d}"/>
      ${active ? `<path class="port-road-flow" d="${d}" style="stroke:${color}"/>` : ""}
      ${packets}`;
  }

  function portBlob(cx, cy, rx, ry, wobble) {
    const n = wobble.length;
    const pts = wobble.map((f, i) => {
      const a = (i / n) * Math.PI * 2;
      return [cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f];
    });
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d + "Z";
  }

  const PORT_SHAPE = {
    outer: [1.03, .965, 1.02, .985, 1.01, .96, 1.025, .98, 1.03, 1, .965, 1.015],
    cliff: [1.015, .97, 1.01, .985, 1.005, .968, 1.015, .985, 1.02, 1, .972, 1.008],
    shore: [1.008, .975, 1.004, .988, 1, .972, 1.01, .99, 1.012, 1, .976, 1.004],
    grass: [1.004, .978, 1.002, .99, 1, .976, 1.006, .992, 1.008, 1, .98, 1.002],
    inner: [1.002, .984, 1.001, .994, 1, .982, 1.003, .995, 1.004, 1, .986, 1.001],
  };

  function portTree(x, y, s = 1, tone = 0) {
    const palettes = [
      ["#5F8C3B", "#4E7A2F", "#79A653"],
      ["#557F35", "#466C2A", "#6E9A49"],
      ["#6A9842", "#567F33", "#87B25C"],
    ];
    const [mid, dark, light] = palettes[tone % palettes.length];
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="1" cy="1" rx="16" ry="5.8" fill="#12201C" opacity=".18"/>
      <path d="M0 0V-11" stroke="#8A6B43" stroke-width="2.6" stroke-linecap="round"/>
      <ellipse cx="-6" cy="-15" rx="10" ry="7.5" fill="${dark}"/>
      <ellipse cx="6" cy="-17" rx="9" ry="7" fill="${light}"/>
      <ellipse cx="0" cy="-24" rx="8" ry="6.5" fill="${mid}"/>
      <ellipse cx="-2" cy="-26" rx="4.5" ry="3" fill="#FFFFFF" opacity=".18"/>
    </g>`;
  }

  function portRock(x, y, s = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="1" rx="12" ry="4" fill="#12201C" opacity=".12"/>
      <path d="M-10 0l3-8 7-3 8 4 2 7z" fill="#B8AC90" stroke="#8F8164" stroke-width="1" stroke-linejoin="round"/>
      <path d="M-10 0l3-8 3 8z" fill="#D8CFB8" opacity=".85"/>
    </g>`;
  }

  function portBoat(x, y, s = 1, flip = false) {
    return `<g class="port-boat" transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
      <ellipse cx="0" cy="11" rx="26" ry="7" fill="#12201C" opacity=".12"/>
      <g class="port-wake" stroke="#FFFFFF" stroke-width="1.7" fill="none" stroke-linecap="round">
        <path d="M-26 5c-9 2-16 3-24 2"/>
        <path d="M-24 10c-8 3-14 4-20 4"/>
      </g>
      <g class="port-boat-bob">
        <path d="M-24 0h48l-8 10h-32z" fill="#F2E7CE" stroke="#12201C" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M-24 0h48l-2 3h-44z" fill="#FF4B2B" opacity=".72"/>
        <path d="M-2 -1v-26" stroke="#12201C" stroke-width="1.8"/>
        <path d="M-1 -25l16 18H-1z" fill="#FFFDF7" stroke="#12201C" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M-3 -21l-12 14h12z" fill="#E8B39E" stroke="#12201C" stroke-width="1.2" stroke-linejoin="round"/>
      </g>
    </g>`;
  }

  function portIslet(x, y, s = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s})" opacity=".62">
      <ellipse cx="0" cy="8" rx="64" ry="16" fill="#12201C" opacity=".08"/>
      <ellipse cx="0" cy="4" rx="58" ry="15" fill="#D9CDA9"/>
      <ellipse cx="0" cy="0" rx="54" ry="13" fill="#B9D086"/>
      ${portTree(-18, 2, .6, 0)}${portTree(20, 4, .5, 1)}
    </g>`;
  }

  function portCloud(x, y, s = 1, delay = 0) {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <g class="port-cloud" style="animation-delay:${delay}s">
        <ellipse cx="0" cy="3" rx="44" ry="12" fill="#FFFDF7" opacity=".86"/>
        <ellipse cx="-30" cy="6" rx="22" ry="9" fill="#FFFDF7" opacity=".62"/>
        <ellipse cx="30" cy="6" rx="26" ry="10" fill="#FFFDF7" opacity=".58"/>
        <ellipse cx="-5" cy="-6" rx="24" ry="12" fill="#FFFDF7" opacity=".92"/>
        <ellipse cx="14" cy="-1" rx="18" ry="9" fill="#FFFDF7" opacity=".78"/>
      </g>
    </g>`;
  }

  function portTuft(x, y, s = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#4F7A32" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".85">
      <path d="M0 0c-1-4-3-6-5-7M0 0c0-5 1-7 2-9M0 0c2-4 5-5 7-6"/>
    </g>`;
  }

  function portButterfly(x, y, color, delay = 0) {
    return `<g transform="translate(${x} ${y})">
      <g class="port-flutter" style="animation-delay:${delay}s">
        <path d="M0 0c-5-6-9-4-8 0-1 4 3 6 8 0z" fill="${color}" stroke="#12201C" stroke-width=".7"/>
        <path d="M0 0c5-6 9-4 8 0 1 4-3 6-8 0z" fill="${color}" stroke="#12201C" stroke-width=".7"/>
      </g>
    </g>`;
  }

  function portWindmill(x, y, s = 1) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spin = reduce ? "" : `<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="12s" repeatCount="indefinite"/>`;
    const blades = [0, 90, 180, 270].map((a) => `<path transform="rotate(${a})" d="M0 -3L4 -20L0 -24L-4 -20Z" fill="#FFFDF7" stroke="#12201C" stroke-width="1" stroke-linejoin="round"/>`).join("");
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="5" rx="17" ry="5.5" fill="#12201C" opacity=".15"/>
      <path d="M-13 3l3 -33h20l3 33z" fill="#F6EEDC" stroke="#12201C" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M-9 3l2 -22h14l2 22z" fill="#E4D8BE" opacity=".7"/>
      <path d="M-5 3v-9a5 5 0 0 1 10 0v9" fill="#8A6B43" stroke="#12201C" stroke-width="1"/>
      <path d="M-12 -30h24l-4 -8h-16z" fill="#D97757" stroke="#12201C" stroke-width="1.2" stroke-linejoin="round"/>
      <g transform="translate(0 -26)">${spin}${blades}<circle r="3" fill="#12201C"/></g>
    </g>`;
  }

  function portCrane(x, y, s = 1, flip = false) {
    const ink = "#2E4A3E";
    return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
      <ellipse cx="0" cy="4" rx="22" ry="6" fill="#12201C" opacity=".14"/>
      <path d="M-12 4v-52M-12 -48h38M26 -48v11" stroke="${ink}" stroke-width="3" stroke-linecap="round" fill="none"/>
      <path d="M-12 -40l11 -8M-12 -48l-12 8" stroke="${ink}" stroke-width="1.4"/>
      <rect x="21" y="-38" width="11" height="9" rx="1.6" fill="#D97757" stroke="#12201C" stroke-width="1"/>
      <path d="M26 -29v10" stroke="#12201C" stroke-width="1.1"/>
      <path d="M26 14a9 5 0 1 0 .1 0" fill="none" stroke="#C9B792" stroke-width="1.2"/>
    </g>`;
  }

  function portContainer(x, y, color, s = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="2" cy="8" rx="23" ry="6.5" fill="#12201C" opacity=".16"/>
      ${portIsoBox(40, 22, 17, color, { windows: false })}
      <path d="M-13 -5l26-13M-11 0l26-13" stroke="#12201C" stroke-width=".7" opacity=".2"/>
    </g>`;
  }

  function portBush(x, y, s = 1, tone = 0) {
    const palettes = [["#5E8A3B", "#85B25C"], ["#547E34", "#7AA650"], ["#68973F", "#93BA63"]];
    const [dark, light] = palettes[tone % palettes.length];
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="1" cy="2" rx="15" ry="4.6" fill="#12201C" opacity=".18"/>
      <ellipse cx="-5" cy="-4" rx="8" ry="6" fill="${dark}"/>
      <ellipse cx="5" cy="-5" rx="7.5" ry="6.4" fill="${light}"/>
      <ellipse cx="0" cy="-9" rx="7" ry="5.6" fill="${dark}"/>
      <ellipse cx="-1" cy="-11" rx="3" ry="1.8" fill="#FFFFFF" opacity=".22"/>
    </g>`;
  }

  function portLamp(x, y, s = 1) {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="2" rx="7" ry="2.4" fill="#12201C" opacity=".18"/>
      <path d="M0 2V-26" stroke="#2E4A3E" stroke-width="2.2" stroke-linecap="round"/>
      <circle class="port-glow" cx="0" cy="-25" r="13" fill="#FFE9A8"/>
      <path d="M-6 -21h12l-2 -9h-8z" fill="#FFE9A8" stroke="#12201C" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M-7 -31h14" stroke="#12201C" stroke-width="1.5" stroke-linecap="round"/>
    </g>`;
  }

  function portCrate(x, y, s = 1, tone = "#D9A05B") {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="1" cy="5" rx="11" ry="3.2" fill="#12201C" opacity=".16"/>
      ${portIsoBox(19, 12, 12, tone, { windows: false, detail: false })}
      <path d="M-5 -7l9-4M-5 -3l9-4" stroke="#12201C" stroke-width=".7" opacity=".28"/>
    </g>`;
  }

  function portBuoy(x, y, s = 1, color = "#FF4B2B") {
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="4" rx="9" ry="3" fill="#0F2A2E" opacity=".12"/>
      <path d="M-4 2c0-4 8-4 8 0l-1 2h-6z" fill="${color}" stroke="#12201C" stroke-width=".9" stroke-linejoin="round"/>
      <path d="M0 0v-10" stroke="#12201C" stroke-width="1.2"/>
      <path d="M0 -10l6 3-6 3z" fill="#FFFDF7" stroke="#12201C" stroke-width=".8"/>
      <ellipse class="port-glint" cx="0" cy="7" rx="6" ry="1.6"/>
    </g>`;
  }

  function portGull(x, y, s = 1, flip = false) {
    return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
      <ellipse cx="0" cy="1" rx="5" ry="1.6" fill="#12201C" opacity=".12"/>
      <path d="M-4 0c0-4 3-7 6-7 3 0 4 3 3 5l3 2-2 1-2-1c-1 2-6 2-8 0z" fill="#FFFDF7" stroke="#12201C" stroke-width=".9" stroke-linejoin="round"/>
      <circle cx="4" cy="-6" r="2.1" fill="#FFFDF7" stroke="#12201C" stroke-width=".9"/>
      <path d="M6 -6h3l-3 1z" fill="#E0A84E" stroke="#12201C" stroke-width=".6"/>
    </g>`;
  }

  function portTruck(path, color, dur, delay) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = reduce ? "" : `<animateMotion dur="${dur}s" begin="${delay}s" repeatCount="indefinite" rotate="auto" path="${path}"/>`;
    return `<g class="port-truck">${motion}
      <g transform="translate(-7 -7)">
        <ellipse cx="7" cy="10" rx="9" ry="2.6" fill="#12201C" opacity=".18"/>
        <path d="M0 0h9l3 4v5H0z" fill="${color}" stroke="#12201C" stroke-width="1" stroke-linejoin="round"/>
        <path d="M9 0l3 4h-3z" fill="#FFF4CE" stroke="#12201C" stroke-width=".9" stroke-linejoin="round"/>
        <circle cx="3" cy="9" r="1.6" fill="#12201C"/><circle cx="9" cy="9" r="1.6" fill="#12201C"/>
      </g>
    </g>`;
  }

  function portPlaza(cx, cy) {
    let rings = "";
    for (let i = 1; i <= 4; i++) {
      rings += `<ellipse cx="0" cy="0" rx="${58 + i * 24}" ry="${21 + i * 9}" fill="none" stroke="#C9B691" stroke-width="1" opacity="${(.42 - i * .06).toFixed(2)}"/>`;
    }
    let dots = "";
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      dots += `<circle cx="${(Math.cos(a) * 132).toFixed(1)}" cy="${(Math.sin(a) * 50).toFixed(1)}" r="1.5" fill="#B7A47E" opacity=".45"/>`;
    }
    let star = "";
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 32 : 82;
      star += `${i ? "L" : "M"}${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r * .38).toFixed(1)}`;
    }
    return `<g class="port-plaza" transform="translate(${cx} ${cy})">
      <ellipse cx="0" cy="0" rx="148" ry="56" fill="#F0E5CB" opacity=".6"/>
      <ellipse cx="0" cy="-3" rx="116" ry="43" fill="#E9DBBC" opacity=".45"/>
      ${rings}${dots}
      <path d="${star}Z" fill="#D9C8A4" opacity=".32"/>
      <path d="M0 -52V52M-140 0H140" stroke="#C9B691" stroke-width="1" opacity=".3"/>
    </g>`;
  }

  function portField(x, y, rx, ry, rot = 0) {
    let rows = "";
    for (let i = -3; i <= 3; i++) {
      rows += `<path d="M${(-rx + 8).toFixed(1)} ${(i * ry / 3.6).toFixed(1)}q${rx} 4 ${(rx * 2 - 16).toFixed(1)} 0"/>`;
    }
    return `<g transform="translate(${x} ${y}) rotate(${rot})" opacity=".5">
      <ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="#DCEDB2" stroke="#B4CE82" stroke-width="1.1"/>
      <g stroke="#A6C374" stroke-width="1.1" fill="none" stroke-linecap="round">${rows}</g>
    </g>`;
  }

  function portSail(x, y, s = 1, flip = false) {
    return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})" opacity=".9">
      <ellipse cx="0" cy="7" rx="18" ry="4" fill="#0F2A2E" opacity=".1"/>
      <path d="M-16 2c4 3 28 3 32 0" fill="#FFFDF7" stroke="#12201C" stroke-width="1.1"/>
      <path d="M0 0v-30" stroke="#12201C" stroke-width="1.2"/>
      <path d="M1 -29l13 22H1z" fill="#FFFDF7" stroke="#12201C" stroke-width="1"/>
      <path d="M-2 -24l-10 17h10z" fill="#F3D9C7" stroke="#12201C" stroke-width="1"/>
    </g>`;
  }

  function portHouse(x, y, s = 1, roof = "#D97757") {
    const w = 34, d = 20, h = 17;
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="${d / 2 + 5}" rx="25" ry="7.8" fill="#12201C" opacity=".2"/>
      <polygon points="${-w / 2},${-h} 0,${-h + d / 2} 0,${d / 2} ${-w / 2},0" fill="#F6EEDC" stroke="#12201C" stroke-width="1.2" stroke-linejoin="round"/>
      <polygon points="0,${-h + d / 2} ${w / 2},${-h} ${w / 2},0 0,${d / 2}" fill="#E4D8BE" stroke="#12201C" stroke-width="1.2" stroke-linejoin="round"/>
      <polygon points="0,${-h - d / 2 - 9} ${w / 2 + 7},${-h - 1} 0,${-h + d / 2 + 5} ${-w / 2 - 7},${-h - 1}" fill="${roof}" stroke="#12201C" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M${(-w / 2 + 9)} 0v-8h7v8" fill="#12201C" opacity=".45"/>
      <path d="M6 ${-h + 5}h9v6h-9z" fill="#FFE9A8" stroke="#12201C" stroke-width=".7"/>
      <circle class="port-puff" cx="${w / 2 - 5}" cy="${-h - d / 2 - 15}" r="2.6" fill="#FFFDF7"/>
      <circle class="port-puff" cx="${w / 2 - 3}" cy="${-h - d / 2 - 21}" r="3.6" fill="#FFFDF7" style="animation-delay:-1.9s"/>
    </g>`;
  }

  function portLighthouse(x, y, s = 1) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const beam = reduce ? "" : `<g>
        <path d="M0 -58 66 -84 66 -32z" fill="#FFF3C9" opacity=".42"/>
        <path d="M0 -58 -66 -84 -66 -32z" fill="#FFF3C9" opacity=".42"/>
        <animateTransform attributeName="transform" type="rotate" from="0 0 -58" to="360 0 -58" dur="16s" repeatCount="indefinite"/>
      </g>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cx="0" cy="6" rx="34" ry="12" fill="#12201C" opacity=".12"/>
      <path d="M-26 4c4-9 16-13 26-13s22 4 26 13z" fill="#B9AC8C" stroke="#8F8164" stroke-width="1.2"/>
      <path d="M-14 0h28l-5-54h-18z" fill="#FFFDF7" stroke="#12201C" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M-11.5 -16h19.5l-2 -13h-15.5z" fill="#FF4B2B" stroke="#12201C" stroke-width="1.2"/>
      <path d="M-9.5 -54h19v-9h-19z" fill="#F7E7B4" stroke="#12201C" stroke-width="1.4"/>
      <path d="M-12 -63h24l-3.6 -8h-16.8z" fill="#12201C"/>
      <circle cx="0" cy="-58" r="3.6" fill="#FFE9A8" stroke="#12201C" stroke-width="1"/>
      ${beam}
    </g>`;
  }

  function portGround() {
    const trees = [
      [236, 430, .95, 0], [300, 350, .85, 1], [336, 588, .9, 2],
      [420, 660, .85, 0], [560, 690, .8, 1], [700, 680, .9, 2],
      [800, 640, .85, 0], [928, 602, .95, 1], [956, 414, .85, 0],
      [892, 362, .9, 2], [500, 306, .8, 2], [704, 300, .8, 1],
      [392, 462, .7, 1], [812, 470, .68, 0],
    ];
    const rocks = [[284, 610, .9], [742, 618, .8], [936, 394, .85], [376, 402, .7]];
    const blooms = [[262, 452, "#FF8A6B"], [318, 620, "#F7C948"], [450, 676, "#FFF1C9"],
      [610, 702, "#FF8A6B"], [770, 654, "#F7C948"], [930, 626, "#FFF1C9"],
      [978, 516, "#FF8A6B"], [866, 386, "#F7C948"], [344, 382, "#FFF1C9"], [648, 664, "#F7C948"],
      [470, 352, "#FF8A6B"], [742, 356, "#FFF1C9"], [240, 522, "#F7C948"]];
    const tufts = [[320, 470], [352, 542], [432, 590], [520, 640], [660, 640], [744, 610],
      [858, 560], [902, 470], [820, 420], [620, 360], [480, 360], [410, 400], [560, 598],
      [682, 598], [760, 520], [822, 500], [300, 570], [392, 602], [540, 422], [660, 422],
      [880, 630], [252, 610], [700, 350], [352, 350]];
    let waves = "";
    for (let i = 0; i < 9; i++) {
      const y = 210 + i * 98;
      const x = i % 2 ? 20 : 120;
      waves += `<path class="port-wave" style="animation-delay:${(i * -.9).toFixed(1)}s" d="M${x} ${y}h${150 + i * 26}M${x + 230} ${y}h${90 + i * 20}" stroke="#8FC0C6" stroke-width="1.1" opacity="${.5 - i * .035}"/>`;
    }
    const glints = [[86, 300, 7], [176, 252, 5], [1048, 258, 6], [1148, 330, 8],
      [74, 508, 6], [1138, 486, 7], [118, 756, 8], [1078, 752, 6], [286, 764, 5],
      [930, 772, 7], [52, 866, 6], [1152, 858, 8], [354, 236, 5], [856, 232, 6],
      [146, 654, 4], [1062, 642, 5], [190, 150, 5], [1010, 160, 6], [600, 160, 4]]
      .map(([x, y, r], i) => `<ellipse class="port-glint" cx="${x}" cy="${y}" rx="${r}" ry="${(r * .34).toFixed(1)}" style="animation-delay:${(i * -.63).toFixed(2)}s"/>`)
      .join("");
    const birds = `<g class="port-birds" aria-hidden="true">
      <path class="port-bird" style="animation-delay:-4s" d="M172 252c2.6-3.4 5.2-3.4 7.8 0 2.6-3.4 5.2-3.4 7.8 0"/>
      <path class="port-bird" style="animation-delay:-13s" d="M236 226c2-2.6 4-2.6 6 0 2-2.6 4-2.6 6 0"/>
      <path class="port-bird" style="animation-delay:-21s" d="M966 236c2.2-2.8 4.4-2.8 6.6 0 2.2-2.8 4.4-2.8 6.6 0"/>
    </g>`;
    const shore = portBlob(600, 486, 400, 234, PORT_SHAPE.shore);
    let striae = "";
    for (let x = 228; x <= 972; x += 32) {
      const t = (x - 600) / 416;
      const yShore = 498 + 246 * Math.sqrt(Math.max(0, 1 - t * t));
      const yRim = 522 + 254 * Math.sqrt(Math.max(0, 1 - t * t));
      striae += `<path d="M${x} ${(yShore + 6).toFixed(1)}V${(yRim + 4).toFixed(1)}"/>`;
    }
    let planks = "";
    for (let x = 216; x < 984; x += 64) {
      planks += `<path d="M${x} 766h28l-32 132h-28z" fill="#B49C72" opacity=".18"/>`;
    }
    let bollards = "";
    [268, 420, 572, 724, 876].forEach((x) => {
      bollards += `<g transform="translate(${x} 872)"><path d="M-4 0v-8h8v8z" fill="#6B5940"/><ellipse cx="0" cy="-8" rx="4" ry="1.4" fill="#8C7A55"/></g>`;
    });
    const boardwalk = `<g class="port-boardwalk">
      <path d="M520 676h160l20 76H500z" fill="#D2BF98" stroke="#A8916A" stroke-width="1.4"/>
      <path d="M158 900 212 744h776l54 156z" fill="#DCC9A5" stroke="#AE986F" stroke-width="1.8" stroke-linejoin="round"/>
      ${planks}
      <path d="M212 744h776l7 20H205z" fill="#EBDCBB" opacity=".9"/>
      <path d="M212 764h776l4 12H208z" fill="#B9A47C" opacity=".45"/>
      <path d="M170 882h860l8 20H160z" fill="#A98F63"/>
      ${bollards}
      <path d="M268 864q76 8 152 0M572 864q76 8 152 0" stroke="#8C7A55" stroke-width="1.2" fill="none" opacity=".45"/>
      <g stroke="#C9B792" stroke-width="1.1">
        <path d="M214 772h772M222 800h756M230 828h740M238 856h724"/>
      </g>
      <g stroke="#BFAE88" stroke-width="1.4" stroke-linecap="round">
        <path d="M212 744v156M276 744v156M340 744v156M404 744v156M468 744v156M532 744v156M596 744v156M660 744v156M724 744v156M788 744v156M852 744v156M916 744v156M980 744v156"/>
      </g>
      <g class="port-rails" stroke="#8C7A55" stroke-width="3.4" stroke-linecap="round">
        <path d="M158 900v-26M1042 900v-26M206 744v-22M994 744v-22"/>
        <path d="M158 876h-14M1042 876h14M206 724h-14M994 724h14"/>
      </g>
      <g transform="translate(236 862)">
        <path d="M0 0l10-5 10 5-10 5z" fill="#E8C98D" stroke="#8C7A55" stroke-width="1"/>
        <path d="M-10 0l10-5v10l-10 5zM10 0l10-5v10l-10 5z" fill="#D2AE72" stroke="#8C7A55" stroke-width="1"/>
      </g>
      <g transform="translate(272 878)">
        <path d="M-9 2v-9a9 3.4 0 0 1 18 0v9" fill="#C79A63" stroke="#8C7A55" stroke-width="1.1"/>
        <ellipse cx="0" cy="-7" rx="9" ry="3.4" fill="#E3BF8B" stroke="#8C7A55" stroke-width="1"/>
      </g>
      <g class="port-pier-lamps" stroke="#12201C" stroke-width="1.6">
        <path d="M174 828v-22M1026 828v-22"/>
        <circle cx="174" cy="802" r="4" fill="#FFE9A8" stroke="#12201C" stroke-width="1.2"/>
        <circle cx="1026" cy="802" r="4" fill="#FFE9A8" stroke="#12201C" stroke-width="1.2"/>
      </g>
      ${portContainer(206, 880, "#D97757", .92)}
      ${portContainer(994, 880, "#3E6B5A", .86)}
      ${portContainer(238, 764, "#E0A84E", .68)}
      ${portContainer(962, 764, "#6D8FB8", .68)}
      ${portCrate(932, 818, .82, "#D9A05B")}${portCrate(950, 826, .68, "#3E6B5A")}
      ${portCrate(252, 820, .72, "#6D8FB8")}
      ${portGull(304, 762, 1)}${portGull(892, 764, .92, true)}
      <g transform="translate(330 800)" stroke="#8C7A55" stroke-width="1.6" fill="none">
        <ellipse cx="0" cy="0" rx="9" ry="3.2"/><ellipse cx="0" cy="0" rx="5" ry="1.8"/>
      </g>
    </g>`;
    const depth = `<g class="port-island">
      <ellipse cx="622" cy="560" rx="496" ry="302" fill="url(#portShadow)"/>
      <ellipse cx="607" cy="536" rx="436" ry="256" fill="#12201C" opacity=".09"/>
      <path d="${portBlob(600, 526, 430, 258, PORT_SHAPE.outer)}" fill="#12201C" opacity=".12"/>
      <path d="${portBlob(600, 522, 424, 254, PORT_SHAPE.cliff)}" fill="#9A855C"/>
      <path d="${portBlob(600, 510, 421, 251, PORT_SHAPE.cliff)}" fill="url(#portCliff)"/>
      <path d="${portBlob(600, 500, 417, 247, PORT_SHAPE.shore)}" fill="url(#portShore)"/>
      <g stroke="#8B7852" stroke-width="1.6" opacity=".16" stroke-linecap="round">${striae}</g>
      <path d="${portBlob(600, 496, 410, 242, PORT_SHAPE.shore)}" fill="#EFE2C4" opacity=".5"/>
      <path d="${portBlob(600, 495, 396, 233, PORT_SHAPE.grass)}" fill="#6E8C4C" opacity=".2"/>
      <path d="${portBlob(600, 488, 393, 230, PORT_SHAPE.grass)}" fill="url(#portGrass)"/>
      <path d="${portBlob(600, 488, 393, 230, PORT_SHAPE.grass)}" fill="url(#portGrassShade)"/>
      <path d="${portBlob(600, 488, 393, 230, PORT_SHAPE.grass)}" fill="none" stroke="#F3FBD8" stroke-width="2" opacity=".38"/>
      <g opacity=".42">
        <ellipse cx="466" cy="566" rx="98" ry="35" fill="#CBE68E"/>
        <ellipse cx="744" cy="592" rx="112" ry="39" fill="#C6E28A"/>
        <ellipse cx="612" cy="384" rx="142" ry="43" fill="#D2EA98"/>
        <ellipse cx="600" cy="470" rx="206" ry="80" fill="#F0E3C4" opacity=".75"/>
      </g>
      <ellipse cx="600" cy="470" rx="196" ry="74" fill="none" stroke="#BDAE86" stroke-width="1.2" stroke-dasharray="3 9" opacity=".55"/>
      <path d="${portBlob(600, 482, 336, 196, PORT_SHAPE.inner)}" fill="#F2F8D8" opacity=".28"/>
      <path d="${portBlob(600, 486, 384, 224, PORT_SHAPE.grass)}" fill="url(#portIslandLight)"/>
      ${portPlaza(600, 470)}
      ${portField(700, 614, 40, 14, -5)}${portField(362, 670, 33, 11, 4)}
      <path d="${shore}" fill="none" stroke="#FFFDF5" stroke-width="2.2" opacity=".5"/>
      <path class="port-foam" d="${portBlob(600, 502, 421, 249, PORT_SHAPE.shore)}" fill="none" stroke="#FFFDF5" stroke-width="2.4" stroke-dasharray="4 12" opacity=".65"/>
      <path d="${portBlob(600, 488, 393, 230, PORT_SHAPE.grass)}" fill="none" stroke="#AFC982" stroke-width="1.4" opacity=".6"/>
      <path d="${portBlob(600, 484, 348, 200, PORT_SHAPE.inner)}" fill="none" stroke="#8FAE66" stroke-width="1" opacity=".22" stroke-dasharray="3 9"/>
    </g>`;
    return `<rect x="-900" y="-900" width="3000" height="2400" fill="url(#portSea)"/>
      <rect x="-900" y="-900" width="3000" height="2400" fill="url(#portSunlight)"/>
      <rect x="-900" y="-900" width="3000" height="2400" fill="url(#portSeaGlow)"/>
      ${glints}
      <g stroke-linecap="round">${waves}</g>
      <g fill="#FFFDF7" opacity=".2">
        <ellipse cx="228" cy="238" rx="54" ry="10"/><ellipse cx="1096" cy="214" rx="46" ry="8"/>
        <ellipse cx="640" cy="150" rx="40" ry="7"/><ellipse cx="150" cy="366" rx="34" ry="6"/>
      </g>
      ${portIslet(150, 330, 1)}${portIslet(1058, 316, .9)}${portIslet(636, 168, .52)}${portIslet(292, 190, .42)}
      ${portCloud(206, 206, 1, 0)}${portCloud(1112, 182, .84, -16)}${portCloud(660, 132, .58, -9)}
      ${birds}
      ${portSail(96, 402, .82)}${portSail(1138, 372, .7, true)}
      ${portBuoy(72, 622, 1)}${portBuoy(1148, 648, .92, "#F7C948")}${portBuoy(1006, 712, .8)}
      <path d="${portBlob(600, 516, 452, 270, PORT_SHAPE.shore)}" fill="none" stroke="#E9F8F3" stroke-width="15" opacity=".26"/>
      <g fill="#BFE2DC" opacity=".35">
        <ellipse cx="188" cy="486" rx="34" ry="9"/><ellipse cx="1010" cy="560" rx="42" ry="11"/>
        <ellipse cx="342" cy="764" rx="30" ry="8"/><ellipse cx="866" cy="778" rx="36" ry="9"/>
      </g>
      ${depth}
      ${portLighthouse(128, 704, .95)}
      <g stroke-linecap="round" opacity=".5">
        <path class="port-wave" d="M170 690c60 10 120 10 180 0M1010 660c-52 9-104 9-156 0" stroke="#FFFFFF" stroke-width="2"/>
      </g>
      ${portHouse(700, 566, .9, "#D97757")}${portHouse(368, 622, .82, "#E0A84E")}
      ${portWindmill(452, 590, .92)}
      ${portLamp(462, 476, 1)}${portLamp(738, 476, 1)}
      ${tufts.map(([x, y]) => portTuft(x, y, .9)).join("")}
      ${trees.map(([x, y, s, t]) => portTree(x, y, s, t)).join("")}
      ${[[330, 452, .9, 0], [668, 598, .82, 1], [862, 654, .88, 2], [486, 376, .78, 1], [726, 390, .84, 0]]
        .map(([x, y, s, t]) => portBush(x, y, s, t)).join("")}
      ${rocks.map(([x, y, s]) => portRock(x, y, s)).join("")}
      ${blooms.map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="2.1" fill="${c}" opacity=".9"/>`).join("")}
      ${portButterfly(300, 646, "#FF8A6B", 0)}${portButterfly(956, 604, "#F7C948", -2.4)}${portButterfly(654, 692, "#FFF1C9", -4.2)}
      ${boardwalk}
      ${portCrane(168, 758, .95, false)}${portCrane(1032, 758, .95, true)}
      <g fill="none" stroke="#FFFDF7" stroke-width="1.3" opacity=".3">
        <ellipse cx="104" cy="594" rx="32" ry="7"/><ellipse cx="118" cy="602" rx="20" ry="4"/>
        <ellipse cx="1104" cy="596" rx="27" ry="6"/><ellipse cx="272" cy="786" rx="22" ry="5"/>
      </g>
      ${portBoat(104, 580, 1.1, false)}${portBoat(1104, 582, .95, true)}${portBoat(272, 772, .8, false)}
      ${[["#FF8A6B", 344, 244], ["#F7C948", 870, 250], ["#FFF1C9", 1006, 366]].map(([c, x, y]) => `<g transform="translate(${x} ${y})"><ellipse cx="0" cy="3" rx="7" ry="2.6" fill="#12201C" opacity=".14"/><circle r="4.4" fill="${c}" stroke="#12201C" stroke-width="1"/><path d="M0 -4v-6" stroke="#12201C" stroke-width="1"/></g>`).join("")}
    </g>`;
  }

  function portRoof(provider, w, d, h, color, warn) {
    const ink = "#12201C";
    const light = mixHex(color, "#FFFFFF", .3);
    const beacon = `<circle cx="${(w * .3).toFixed(1)}" cy="${(-h + 7).toFixed(1)}" r="3" fill="${warn ? "#FF4B2B" : "#C8F169"}" stroke="${ink}" stroke-width="1"/>`;
    const dish = `<g transform="translate(${(-w * .2).toFixed(1)} ${(-h - 2).toFixed(1)})">
      <path d="M0 0v-9" stroke="${ink}" stroke-width="1.6"/>
      <g transform="rotate(-16 0 -13)"><ellipse cx="0" cy="-13" rx="10.5" ry="4.4" fill="#FFFDF7" stroke="${ink}" stroke-width="1.1"/><path d="M-4 -13h7" stroke="${ink}" stroke-width=".8" opacity=".5"/></g>
      <circle cx="0" cy="-17" r="1.6" fill="#FF4B2B"/>
    </g>`;
    const dome = `<g transform="translate(0 ${(-h + 1).toFixed(1)})">
      <path d="M-17 0a17 15 0 0 1 34 0z" fill="${light}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M-17 0c5 4 29 4 34 0" fill="none" stroke="${ink}" stroke-width="1" opacity=".28"/>
      <path d="M0 -15v-7" stroke="${ink}" stroke-width="1.4"/>
      <circle cx="0" cy="-24" r="2.6" fill="#C8F169" stroke="${ink}" stroke-width="1"/>
    </g>`;
    const smoke = (x, y) => `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <path d="M-5 0v-15h10v15" fill="${light}" stroke="${ink}" stroke-width="1.1"/>
      <circle class="port-puff" cx="0" cy="-19" r="3" fill="#FFFDF7"/>
      <circle class="port-puff" cx="2.5" cy="-25" r="4.2" fill="#FFFDF7" style="animation-delay:-1.4s"/>
      <circle class="port-puff" cx="-1.5" cy="-32" r="5.2" fill="#FFFDF7" style="animation-delay:-2.7s"/>
    </g>`;
    const vents = `<g transform="translate(0 ${(-h - 2).toFixed(1)})" stroke="${ink}" stroke-width="1.1">
      <path d="M-15 0h30M-12 -5h24M-9 -10h18" opacity=".5"/>
      <path d="M11 0v-11h10v11" fill="${light}" stroke-width="1.2"/>
    </g>${smoke(w * .22, -h + 2)}`;
    const kind = {
      codex: "dish", openrouter: "dish", claude: "dome",
      antigravity: "dome", gemini: "dome", nvidia: "vents",
    }[provider] || "chimney";
    const body = kind === "dish" ? dish : kind === "dome" ? dome : kind === "vents" ? vents : smoke(w * .24, -h + 2);
    return body + beacon;
  }

  function portAiNode(p, slot, idx) {
    const meta = provMeta(p.provider);
    const today = state.snap?.today?.providers?.[p.provider] || {};
    const conn = (state.snap?.connections || []).find((c) => c.provider === p.provider);
    const warn = conn && conn.status !== "active";
    const on = portSelected("ai", p.provider);
    const size = idx === 0 ? 1.12 : 1;
    const share = Number(p.share) || 0;
    const w = 124 * size, d = 60 * size, h = (62 + Math.min(64, share * .95)) * size;
    const active = Number(today.tokens) > 0;
    const roof = portRoof(p.provider, w, d, h, meta.color, warn);
    return `<g class="port-node ai${on ? " on" : ""}${warn ? " warn" : ""}" data-act="port-select" data-kind="ai" data-key="${esc(p.provider)}" tabindex="0" role="button" aria-label="${esc(meta.name)}, ${esc(tr("port.roleAiName"))} ${esc(meta.vendor)}, ${pct(p.share, 0)} ${esc(tr("port.shareOfUse"))}">
      <title>${esc(meta.name)} · ${esc(meta.vendor)} · ${compact(p.tokens)} tokens</title>
      <g transform="translate(${slot.x} ${slot.y})">
        <ellipse class="port-plate" cx="0" cy="${d / 2 + 10}" rx="${w * .74}" ry="${d * .42}"/>
        ${active ? `<ellipse class="port-pulse" cx="0" cy="${d / 2 + 8}" rx="${w * .82}" ry="${d * .58}"/>` : ""}
        ${on ? `<ellipse class="port-ring" cx="0" cy="${d / 2 + 6}" rx="${w * .92}" ry="${d * .66}"/>` : ""}
        ${portIsoBox(w, d, h, meta.color, { extra: roof, glow: active, dense: true, rows: [0.16, 0.36, 0.56, 0.76] })}
        <g class="port-flag" style="--pc:${meta.color}"><path d="M${w / 2} ${-h - 16}v18"/><path d="M${w / 2} ${-h - 16}h16l-4 5 4 5h-16z"/></g>
        <text class="port-name" y="${d / 2 + 36}" text-anchor="middle">${esc(meta.name)}</text>
        <text class="port-role" y="${d / 2 + 51}" text-anchor="middle">${esc(meta.vendor).toUpperCase()} · ${pct(p.share, 0)}</text>
        <text class="port-stat" y="${d / 2 + 66}" text-anchor="middle">${active ? tr("port.todayUse", { v: compact(today.tokens) }) : tr("port.noUseToday")}</text>
        <rect class="port-hit" x="${-w * .95}" y="${-h - d - 40}" width="${w * 1.9}" height="${h + d + 128}"/>
      </g>
    </g>`;
  }

  function portSourceNode() {
    const on = portSelected("source", "9router");
    const S = state.snap;
    const router = S?.router || {};
    const conns = (S?.connections || []).filter((c) => c.status === "active").length;
    const signal = S?.meta?.sources?.find((s) => s.key === "router")?.status === "ok";
    const tower = `<g transform="translate(0 -66)">
      ${portIsoBox(72, 48, 66, "#2C6157", { rows: [0.3, 0.62], extra: `<path d="M0 -66V-90" stroke="#12201C" stroke-width="1.6"/><circle class="port-beacon" cx="0" cy="-94" r="19"/><circle cx="0" cy="-94" r="14" fill="#C8F169" stroke="#12201C" stroke-width="1.6"/><text x="0" y="-88.5" text-anchor="middle" class="port-nine">9</text>` })}
    </g>`;
    return `<g class="port-node source${on ? " on" : ""}" data-act="port-select" data-kind="source" data-key="9router" tabindex="0" role="button" aria-label="${esc(tr("port.sourceAria"))}">
      <title>9router · ${esc(tr("port.sourceTag"))} · ${conns} ${esc(tr("port.connections"))}</title>
      <g transform="translate(${PORT_LAYOUT.source.x} ${PORT_LAYOUT.source.y})">
        <ellipse class="port-harbor" cx="0" cy="18" rx="182" ry="67"/>
        <ellipse class="port-harbor-line" cx="0" cy="18" rx="148" ry="51"/>
        ${on ? `<ellipse class="port-ring strong" cx="0" cy="16" rx="190" ry="75"/>` : ""}
        ${portIsoBox(226, 114, 66, "#245A50", { rows: [0.3, 0.62], glow: signal })}
        ${tower}
        <path class="port-crane" d="M-112 20v-70h34M104 20v-52h-28" stroke="#12201C" stroke-width="2" fill="none"/>
        <path class="port-crane" d="M-112 -50v10M104 -32v8" stroke="#12201C" stroke-width="4" stroke-linecap="round"/>
        <text class="port-name" y="104" text-anchor="middle">9router</text>
        <text class="port-role" y="120" text-anchor="middle">${esc(tr("port.sourceRole"))}</text>
        <text class="port-stat" y="136" text-anchor="middle">${esc(tr("port.connShort", { n: conns, c: router.combos?.length || 0 }))}</text>
        <rect class="port-hit" x="-196" y="-220" width="392" height="380"/>
      </g>
    </g>`;
  }

  function portToolRoof(tool, w, d, h) {
    const ink = "#12201C";
    if (!tool.installed) {
      return `<g transform="translate(${(-w * .18).toFixed(1)} ${(-h - 2).toFixed(1)})">
        <path d="M-7 0v-8h14v8" fill="#DED6C4" stroke="${ink}" stroke-width="1"/>
        <path d="M-9 -8h18" stroke="${ink}" stroke-width="1.2"/>
        <circle cx="8" cy="-3" r="2" fill="#F4F0E5" stroke="#8F8778" stroke-width=".9"/>
      </g>`;
    }
    return `<g>
      <path d="M${(-w * .3).toFixed(1)} ${(-h + 1).toFixed(1)}l10 -5 10 5-10 5z" fill="#FFF4CE" stroke="${ink}" stroke-width="1" stroke-linejoin="round"/>
      <g transform="translate(${(w * .2).toFixed(1)} ${(-h - 2).toFixed(1)})">
        <path d="M0 0v-9" stroke="${ink}" stroke-width="1.2"/>
        <circle cx="0" cy="-11" r="2.1" fill="#C8F169" stroke="${ink}" stroke-width=".9"/>
      </g>
    </g>`;
  }

  function portToolNode(tool, slot) {
    const on = portSelected("tool", tool.key);
    const w = 74, d = 40, h = 52;
    const color = tool.installed ? "#3E6B5A" : "#BDB6A4";
    const flag = tool.installed ? `<path d="M${w / 2} ${-h - 10}v18" stroke="#12201C" stroke-width="1.3"/><path d="M${w / 2} ${-h - 10}h15l-3.4 5 3.4 5h-15z" fill="${color}" stroke="#12201C" stroke-width="1"/>` : `<circle cx="0" cy="${-h - 18}" r="4.4" fill="#F4F0E5" stroke="#8F8778" stroke-width="1.2"/><path d="M0 ${-h - 18}v-5" stroke="#8F8778" stroke-width="1.2"/>`;
    return `<g class="port-node tool${on ? " on" : ""}${tool.installed ? " live" : " off"}" data-act="port-select" data-kind="tool" data-key="${esc(tool.key)}" tabindex="0" role="button" aria-label="${esc(tool.name)}, ${esc(tr("port.toolTag"))} ${esc(tool.installed ? tr("port.installed") : tr("port.missing"))}">
      <title>${esc(tool.name)} · ${esc(tool.installed ? tr("port.installed") : tr("port.missing"))}</title>
      <g transform="translate(${slot.x} ${slot.y})">
        <ellipse class="port-plate" cx="0" cy="${d / 2 + 9}" rx="46" ry="15"/>
        ${on ? `<ellipse class="port-ring" cx="0" cy="${d / 2 + 6}" rx="58" ry="25"/>` : ""}
        ${portIsoBox(w, d, h, color, { cols: 0.7, rows: [0.28, 0.6], extra: flag + portToolRoof(tool, w, d, h), glow: tool.installed })}
        <text class="port-name small" y="${d / 2 + 30}" text-anchor="middle">${esc(tool.name)}</text>
        <text class="port-role" y="${d / 2 + 45}" text-anchor="middle">${esc((tool.installed ? tr("port.installed") : tr("port.missing")).toUpperCase())}</text>
        <rect class="port-hit" x="-60" y="${-h - 44}" width="120" height="${h + d + 106}"/>
      </g>
    </g>`;
  }

  function renderPort() {
    const world = $("#portWorld");
    if (!world || !state.snap) return;
    const S = state.snap;
    const providers = portProviders();
    const tools = portTools();
    const sel = state.port.selected;
    if (sel?.kind === "ai" && !providers.some((p) => p.provider === sel.key)) state.port.selected = null;

    const nodes = [];
    providers.forEach((p, i) => nodes.push({ y: PORT_LAYOUT.ai[i].y, html: portAiNode(p, PORT_LAYOUT.ai[i], i) }));
    nodes.push({ y: PORT_LAYOUT.source.y, html: portSourceNode() });
    tools.forEach((t, i) => nodes.push({ y: PORT_LAYOUT.tool[i].y, html: portToolNode(t, PORT_LAYOUT.tool[i]) }));
    nodes.sort((a, b) => a.y - b.y);

    const roads = [];
    providers.forEach((p, i) => {
      const slot = PORT_LAYOUT.ai[i];
      const meta = provMeta(p.provider);
      const active = Number(S.today?.providers?.[p.provider]?.tokens || 0) > 0;
      const d = `M${slot.x} ${slot.y + 14} C${slot.x} ${slot.y - 34} 600 ${450} 600 468`;
      roads.push(portRoad(d, meta.color, active));
      if (active) roads.push(portTruck(d, meta.color, (8.6 + i * 1.5).toFixed(1), (-(i * 2.7)).toFixed(1)));
    });
    tools.forEach((tool, i) => {
      const slot = PORT_LAYOUT.tool[i];
      const d = `M${slot.x} ${slot.y - 18} C${slot.x} ${slot.y - 190} 600 ${slot.y - 170} 600 512`;
      roads.push(portRoad(d, tool.installed ? "#2C6157" : "#B4AC99", tool.installed));
    });

    $("#portRoads").innerHTML = portGround() + roads.join("");
    $("#portBuildings").innerHTML = nodes.map((n) => n.html).join("");
    renderPortHud();
    renderPortInspector();
    renderPortList();
    applyPortCamera();
  }

  function renderPortHud() {
    const S = state.snap;
    if (!S || !$("#portHeadline")) return;
    const d = dateObj(S.meta?.now) || new Date();
    $("#portKicker").textContent = `${tr("port.kicker")} · ${String(d.getDate()).padStart(2, "0")} ${monthShort(d).toUpperCase()}`;
    const bad = (S.connections || []).filter((c) => c.status && c.status !== "active").length;
    const headline = bad
      ? tr(bad === 1 ? "port.attentionOne" : "port.attentionMany", { n: bad })
      : Number(S.today?.requests) > 0 ? tr("port.good") : tr("port.empty");
    $("#portHeadline").textContent = headline;
    const ais = portProviders().length;
    const tools = portTools().filter((t) => t.installed).length;
    const age = Number(S.meta?.router_age || 0) + (Date.now() - state.loadedAt) / 1000;
    $("#portSub").textContent = tr("port.sub", { ais, tools, ago: ago(age) });
    $("#dockTokens").textContent = compact(S.today?.tokens || 0);
    $("#dockCost").textContent = money(S.today?.cost || 0);
    const free = S.quota?.codex?.available ? S.quota.codex.week_free : state.sunStates[0]?.pct;
    $("#dockFree").textContent = free != null ? pct(free, 0) : "—";
    const fkeys = fleetKeys();
    const answered = fkeys.filter((k) => probeFor(k)?.status === "ok").length;
    const tested = fkeys.filter((k) => probeFor(k) && probeFor(k).status !== "running").length;
    const routesEl = $("#dockRoutes");
    if (routesEl) {
      routesEl.textContent = tested ? `${answered}/${fkeys.length}` : "—";
      const wrap = $("#dockRoutesWrap");
      if (wrap) {
        wrap.classList.toggle("ok", tested > 0 && answered === fkeys.length);
        wrap.classList.toggle("warn", tested > 0 && answered < fkeys.length);
      }
    }
    const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
    set("#portManualLabel", tr("port.manual"));
    set("#portHintText", tr("port.hint"));
    set("#portLegendSource", tr("port.legendSource"));
    set("#portLegendAi", tr("port.legendAi"));
    set("#portLegendTool", tr("port.legendTool"));
    set("#dockTokensLabel", tr("port.dockToday"));
    set("#dockCostLabel", tr("port.dockCost"));
    set("#dockCostSub", tr("port.dockToday"));
    set("#dockFreeLabel", tr("port.dockFree"));
    set("#dockFreeSub", tr("port.dockWeek"));
    set("#dockRoutesLabel", tr("port.dockRoutes"));
    set("#dockRoutesSub", tr("port.dockRoutesSub"));
    set("#dockActionLabel", tr("port.dockFlow"));
  }

  function portStatusFor(provider) {
    const conn = (state.snap?.connections || []).find((c) => c.provider === provider);
    if (!conn) return { tone: "none", label: tr("port.noConnection") };
    if (conn.status === "active") return { tone: "ok", label: tr("port.connected") };
    return { tone: "warn", label: conn.errorCode ? `${tr("port.attention")} · ${conn.errorCode}` : tr("port.attention") };
  }

  function renderPortInspector() {
    const el = $("#inspector");
    if (!el) return;
    if (!state.snap) { el.innerHTML = `<div class="ins-loading"><i></i><span>${esc(tr("common.loading"))}</span></div>`; return; }
    const sel = state.port.selected;
    if (!sel) { el.innerHTML = portInspectorToday(); return; }
    el.innerHTML = sel.kind === "source" ? portInspectorSource() : sel.kind === "ai" ? portInspectorAi(sel.key) : portInspectorTool(sel.key);
  }

  function quayBlock() {
    const fkeys = fleetKeys();
    if (!fkeys.length) return "";
    const results = fkeys.filter((k) => probeFor(k) && probeFor(k).status !== "running");
    const ok = results.filter((k) => probeFor(k).status === "ok");
    const fail = results.filter((k) => probeFor(k).status === "fail");
    const untested = fkeys.length - results.length;
    const rows = [...fail, ...ok].slice(0, 4);
    const busy = state.probingAll;
    return `<div class="ins-block ins-quay">
      <span class="ins-label">${esc(tr("port.quay"))}</span>
      <div class="quay-head">
        <b>${esc(tr("port.quayCount", { ok: ok.length, total: fkeys.length }))}</b>
        <button class="quay-test" data-act="probe-all"${busy ? " disabled" : ""}>${esc(busy ? tr("port.quayTesting") : tr("port.quayTest"))}</button>
      </div>
      ${rows.map((k) => {
        const p = probeFor(k);
        const msg = p.status === "ok" ? (p.model || "") : friendlyError(p.error);
        return `<button class="quay-row ${p.status === "ok" ? "ok" : "bad"}" data-act="provider-detail" data-key="${esc(k)}" title="${esc(msg)}"><i></i><b>${esc(provMeta(k).name)}</b><em>${esc(msg || "—")}</em><span>→</span></button>`;
      }).join("")}
      ${untested ? `<div class="quay-note">${esc(tr("port.quayIdle", { n: untested }))}</div>` : ""}
      ${!untested && fail.length ? `<div class="quay-note">${esc(tr("port.quayAttention", { n: fail.length }))}</div>` : ""}
    </div>`;
  }

  function portInspectorToday() {
    const S = state.snap;
    const t = S.today || {};
    const next = recommendedActions()[0];
    const free = S.quota?.codex?.available ? S.quota.codex.week_free : state.sunStates[0]?.pct;
    const bad = (S.connections || []).filter((c) => c.status && c.status !== "active").length;
    const d = dateObj(S.meta?.now) || new Date();
    const nextAction = next
      ? `<button class="ins-action" data-act="${esc(next.act || "wing")}"${next.wing ? ` data-key="${esc(next.wing)}"` : ""}>
          <span><b>${esc(next.label)}</b><em>${esc(next.detail)}</em></span><i>→</i>
        </button>`
      : `<button class="ins-action" data-act="wing" data-key="fluxo"><span><b>${esc(tr("port.nextFlow"))}</b><em>${esc(tr("port.nextFlowSub"))}</em></span><i>→</i></button>`;
    const series = (S.series || []).slice(-7);
    const peak = Math.max(1, ...series.map((s) => s.tokens || 0));
    const todayKey = String(S.meta?.now || "").slice(0, 10);
    const rhythm = series.length
      ? `<div class="ins-block ins-rhythm">
          <span class="ins-label">${esc(tr("port.rhythm"))}</span>
          <div class="rhythm">
            ${series.map((s) => {
              const h = Math.max(5, Math.round(((s.tokens || 0) / peak) * 100));
              const isToday = s.date === todayKey;
              return `<div class="rhythm-col${isToday ? " today" : ""}" title="${esc(s.label)} · ${compact(s.tokens || 0)} ${esc(tr("common.tokens"))} · ${int(s.requests || 0)} ${esc(tr("port.rhythmCalls"))}">
                <i style="--h:${h}%"></i><span>${esc(s.weekday || "")}</span>
              </div>`;
            }).join("")}
          </div>
        </div>`
      : "";
    return `<div class="ins-head">
        <span class="ins-eyebrow">${esc(tr("common.today")).toUpperCase()} · ${String(d.getDate()).padStart(2, "0")} ${monthShort(d).toUpperCase()}</span>
        <span class="ins-status ${bad ? "warn" : "ok"}"><i></i>${esc(bad ? tr("port.attention") : tr("port.collecting"))}</span>
      </div>
      <h2 class="ins-title">${esc(tr("port.todayTitle"))}</h2>
      <p class="ins-lead">${esc(tr("port.lead", { tokens: compact(t.tokens || 0), calls: int(t.requests || 0), cache: pct(S.totals?.cacheHit || 0) }))}</p>
      <div class="ins-stats">
        <div><span>${esc(tr("common.tokens"))}</span><b>${compact(t.tokens || 0)}</b></div>
        <div><span>${esc(tr("common.cost"))}</span><b>${money(t.cost || 0)}</b></div>
        <div><span>${esc(tr("common.calls"))}</span><b>${int(t.requests || 0)}</b></div>
        <div><span>${esc(tr("common.cache"))}</span><b>${pct(S.totals?.cacheHit || 0)}</b></div>
        <div><span>${esc(tr("port.headroom"))}</span><b>${free != null ? pct(free, 0) : "—"}</b></div>
        <div><span>${esc(tr("common.model"))}</span><b class="is-model">${esc(modelName(S.insights?.topModel?.model) || "—")}</b></div>
      </div>
      ${rhythm}
      ${quayBlock()}
      <div class="ins-block">
        <span class="ins-label">${esc(tr("port.nextAction"))}</span>
        ${nextAction}
      </div>
      <div class="ins-block">
        <span class="ins-label">${esc(tr("port.roles"))}</span>
        <div class="ins-roles">
          <div><i class="lg lg-source"></i><span><b>9router</b><em>${esc(tr("port.roleSource"))}</em></span></div>
          <div><i class="lg lg-ai"></i><span><b>${esc(tr("port.roleAiName"))}</b><em>${esc(tr("port.roleAi"))}</em></span></div>
          <div><i class="lg lg-tool"></i><span><b>${esc(tr("port.roleToolName"))}</b><em>${esc(tr("port.roleTool"))}</em></span></div>
        </div>
      </div>
      <p class="ins-note">${esc(tr("port.inspectorHint"))}</p>
      <button class="ins-cta" data-act="manual">${esc(tr("port.howTo"))} <span>5 ${esc(tr("port.steps"))}</span></button>`;
  }

  function portInspectorSource() {
    const S = state.snap;
    const router = S.router || {};
    const links = router.links || [];
    const conns = S.connections || [];
    const ok = conns.filter((c) => c.status === "active").length;
    const link = links.find((l) => /9router/i.test(l.label)) || links[0];
    return `<button class="ins-back" data-act="port-clear">← ${esc(tr("port.backMap"))}</button>
      <div class="ins-head">
        <span class="ins-mark source">9</span>
        <span class="ins-tag source">${esc(tr("port.sourceTag"))}</span>
      </div>
      <h2 class="ins-title">9router</h2>
      <p class="ins-lead">${esc(tr("port.sourceLead"))}</p>
      <div class="ins-callout">${esc(tr("port.sourceCallout"))}</div>
      <div class="ins-rows">
        <div><span>${esc(tr("port.fallback"))}</span><b>${esc(router.fallback || "—")}</b></div>
        <div><span>${esc(tr("port.combos"))}</span><b>${int(router.combos?.length || 0)}</b></div>
        <div><span>${esc(tr("port.connections"))}</span><b>${ok}/${conns.length}</b></div>
        <div><span>${esc(tr("port.tunnel"))}</span><b>${router.tunnel ? esc(tr("port.on")) : esc(tr("port.off"))}</b></div>
        <div><span>${esc(tr("port.headroom"))}</span><b>${esc(router.headroom?.online ? tr("port.online") : tr("port.offline"))}</b></div>
      </div>
      <div class="ins-actions">
        ${link ? `<button class="btn primary" data-act="open-url" data-url="${esc(link.url)}">${esc(tr("port.openRouter"))} ↗</button>` : ""}
        <button class="btn ghost" data-act="wing" data-key="perfil">${esc(tr("port.seeConnections"))}</button>
      </div>
      <p class="ins-note">${esc(tr("port.privacy"))}</p>`;
  }

  function portInspectorAi(key) {
    const S = state.snap;
    const meta = provMeta(key);
    const usage = (S.providers || []).find((p) => p.provider === key);
    const today = S.today?.providers?.[key] || {};
    const kb = knowledgeFor(key);
    const status = portStatusFor(key);
    return `<button class="ins-back" data-act="port-clear">← ${esc(tr("port.backMap"))}</button>
      <div class="ins-head">
        <span class="ins-mark" style="--pc:${meta.color}">${esc(meta.glyph)}</span>
        <span class="ins-tag">IA · ${esc(meta.vendor)}</span>
        <span class="ins-status ${status.tone}"><i></i>${esc(status.label)}</span>
      </div>
      <h2 class="ins-title">${esc(meta.name)}</h2>
      <p class="ins-lead clamp">${esc(kb?.purpose || tr("port.aiLead"))}</p>
      <div class="ins-stats four">
        <div><span>${esc(tr("common.today"))}</span><b>${compact(today.tokens || 0)}</b></div>
        <div><span>${esc(tr("common.calls"))}</span><b>${int(today.requests || 0)}</b></div>
        <div><span>${esc(tr("common.cost"))}</span><b>${money(usage?.cost || 0)}</b></div>
        <div><span>${esc(tr("port.share"))}</span><b>${pct(usage?.share || 0, 0)}</b></div>
      </div>
      <div class="ins-rows">
        <div><span>${esc(tr("port.totalTokens"))}</span><b>${compact(usage?.tokens || 0)}</b></div>
        <div><span>${esc(tr("port.via"))}</span><b>9router</b></div>
        <div><span>${esc(tr("port.profile"))}</span><b>${esc(kb?.tag || "—")}</b></div>
      </div>
      <div class="ins-actions">
        <button class="btn primary" data-act="provider-detail" data-key="${esc(key)}">${esc(tr("port.aiManual"))}</button>
        <button class="btn ghost" data-act="focus-flow" data-key="${esc(key)}">${esc(tr("port.seeFlow"))}</button>
      </div>
      <p class="ins-note">${esc(tr("port.privacy"))}</p>`;
  }

  function portInspectorTool(key) {
    const tool = portTools().find((t) => t.key === key);
    if (!tool) return portInspectorToday();
    const S = state.snap;
    const sessions = key === "qoder" ? (S.qoder?.sessions?.length || 0) : null;
    return `<button class="ins-back" data-act="port-clear">← ${esc(tr("port.backMap"))}</button>
      <div class="ins-head">
        <span class="ins-mark tool">${esc(tool.name.slice(0, 2).toUpperCase())}</span>
        <span class="ins-tag tool">${esc(tr("port.toolTag"))}</span>
        <span class="ins-status ${tool.installed ? "ok" : "warn"}"><i></i>${esc(tool.installed ? tr("port.installed") : tr("port.missing"))}</span>
      </div>
      <h2 class="ins-title">${esc(tool.name)}</h2>
      <p class="ins-lead">${esc(tr("port.toolLead", { name: tool.name }))}</p>
      <div class="ins-rows">
        <div><span>${esc(tr("port.kind"))}</span><b>${tool.kind === "cli" ? "CLI" : "App"}</b></div>
        <div><span>${esc(tr("port.readFrom"))}</span><b>${esc(tool.source)}</b></div>
        ${sessions != null ? `<div><span>${esc(tr("port.sessions"))}</span><b>${int(sessions)}</b></div>` : ""}
      </div>
      <p class="ins-note">${esc(tr(tool.noteKey))}</p>
      ${tool.installed
        ? `<div class="ins-actions"><button class="btn primary" data-act="wing" data-key="sessoes">${esc(tr("port.seeSessions"))}</button></div>`
        : `<div class="ins-callout">${esc(tr("port.toolMissingNote"))}</div>
           <div class="ins-actions"><button class="btn primary" data-act="manual-step" data-step="2">${esc(tr("port.howToConnect"))}</button></div>`}
      <p class="ins-note">${esc(tr("port.privacy"))}</p>`;
  }

  function renderPortList() {
    const wrap = $("#portList");
    if (!wrap || !state.snap) return;
    const providers = portProviders();
    const tools = portTools();
    const row = (kind, key, dot, name, sub, value, cls = "") => `<button class="pl-row ${cls}" data-act="port-select" data-kind="${kind}" data-key="${esc(key)}">
      <i class="${dot}"></i><span><b>${esc(name)}</b><em>${esc(sub)}</em></span><strong>${value}</strong><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
    wrap.innerHTML = `
      <div class="pl-group"><span>${esc(tr("port.sourceTag"))}</span>${row("source", "9router", "lg-source", "9router", tr("port.roleSource"), "")}</div>
      <div class="pl-group"><span>${esc(tr("port.roleAiName"))}</span>${providers.map((p) => row("ai", p.provider, "lg-ai", provName(p.provider), provMeta(p.provider).vendor, compact(p.tokens))).join("")}</div>
      <div class="pl-group"><span>${esc(tr("port.roleToolName"))}</span>${tools.map((t) => row("tool", t.key, "lg-tool", t.name, t.installed ? tr("port.installed") : tr("port.missing"), t.installed ? "✓" : "—", t.installed ? "live" : "off")).join("")}</div>`;
  }

  function applyPortCamera() {
    const world = $("#portWorld");
    const vp = $("#portViewport");
    if (!world || !vp) return;
    const p = state.port;
    const rect = vp.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const hud = $(".port-hud");
    const dock = $(".port-dock");
    const overlays = (el) => Boolean(el && getComputedStyle(el).position === "absolute");
    // A cena é enquadrada só na faixa livre entre o HUD e o dock.
    const topPad = overlays(hud) ? Math.max(0, hud.getBoundingClientRect().bottom - rect.top) + 14 : 10;
    const bottomPad = overlays(dock) ? Math.max(0, rect.bottom - dock.getBoundingClientRect().top) + 14 : 10;
    const freeH = Math.max(240, rect.height - topPad - bottomPad);
    const narrow = rect.width < 620;
    const contentW = narrow ? 900 : 1070;
    const contentH = narrow ? 700 : 770;
    const scale = Math.max(contentW / rect.width, contentH / freeH);
    const vbW = (rect.width * scale) / p.k;
    const vbH = (rect.height * scale) / p.k;
    p.cx = vbW >= 1240 ? 600 : clamp(p.cx, vbW / 2 - 80, 1280 - vbW / 2);
    p.cy = vbH >= 1080 ? 500 : clamp(p.cy, vbH / 2 - 90, 1090 - vbH / 2);
    const bandCenter = (topPad + freeH / 2) / rect.height;
    const x = p.cx - vbW / 2;
    const y = p.cy - bandCenter * vbH;
    world.setAttribute("viewBox", `${x.toFixed(1)} ${y.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`);
  }

  function portZoom(factor) {
    state.port.k = Math.min(2.4, Math.max(1, state.port.k * factor));
    applyPortCamera();
  }

  function portResetCamera() {
    state.port.cx = 600;
    state.port.cy = 540;
    state.port.k = 1;
    applyPortCamera();
  }

  function portSelect(kind, key) {
    const p = state.port;
    if (p.selected && p.selected.kind === kind && p.selected.key === key) p.selected = null;
    else p.selected = { kind, key };
    renderPort();
    if (p.selected && window.matchMedia("(max-width: 900px)").matches) {
      setTimeout(() => $("#inspector")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  }

  function initPortCamera() {
    const vp = $("#portViewport");
    if (!vp || vp.dataset.ready) return;
    vp.dataset.ready = "1";
    let drag = null;
    vp.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest?.("[data-act]")) return;
      drag = { x: ev.clientX, y: ev.clientY, cx: state.port.cx, cy: state.port.cy };
      vp.setPointerCapture?.(ev.pointerId);
      vp.classList.add("dragging");
    });
    vp.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 10) {
        $("#portHint")?.classList.add("is-hidden");
      }
      const rect = vp.getBoundingClientRect();
      const unit = 1200 / state.port.k / Math.max(1, rect.width);
      state.port.cx = drag.cx - (ev.clientX - drag.x) * unit;
      state.port.cy = drag.cy - (ev.clientY - drag.y) * unit;
      applyPortCamera();
    });
    const stop = () => { drag = null; vp.classList.remove("dragging"); };
    vp.addEventListener("pointerup", stop);
    vp.addEventListener("pointercancel", stop);
    window.addEventListener("resize", applyPortCamera);
    window.addEventListener("resize", applyUiScale);
    // O HUD, o dock e as fontes mudam de altura depois do primeiro render:
    // reenquadra a cena sempre que a faixa livre mudar.
    document.fonts?.ready?.then(() => applyPortCamera());
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => applyPortCamera());
      [vp, $(".port"), $(".port-hud"), $(".port-dock"), $("#inspector")].forEach((el) => el && ro.observe(el));
    }
    vp.addEventListener("wheel", (ev) => {
      if (window.innerWidth < 900) return;
      ev.preventDefault();
      portZoom(ev.deltaY > 0 ? .9 : 1.12);
    }, { passive: false });
    vp.addEventListener("keydown", (ev) => {
      const step = 46;
      if (ev.key === "ArrowLeft") { state.port.cx -= step; applyPortCamera(); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { state.port.cx += step; applyPortCamera(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { state.port.cy -= step; applyPortCamera(); ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { state.port.cy += step; applyPortCamera(); ev.preventDefault(); }
      else if (ev.key === "+" || ev.key === "=") { portZoom(1.14); ev.preventDefault(); }
      else if (ev.key === "-") { portZoom(.88); ev.preventDefault(); }
      else if (ev.key === "0") { portResetCamera(); ev.preventDefault(); }
    });
    $("#portWorld").addEventListener("keydown", (ev) => {
      const node = ev.target.closest?.(".port-node");
      if (!node) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        portSelect(node.dataset.kind, node.dataset.key);
      }
    });
  }

  /* ---------------------------------------------------------- manual */

  const MANUAL_STEPS = [
    { icon: "◎", titleKey: "manual.step1.title", textKey: "manual.step1.text" },
    { icon: "⌁", titleKey: "manual.step2.title", textKey: "manual.step2.text" },
    { icon: "⇄", titleKey: "manual.step3.title", textKey: "manual.step3.text" },
    { icon: "✓", titleKey: "manual.step4.title", textKey: "manual.step4.text" },
    { icon: "→", titleKey: "manual.step5.title", textKey: "manual.step5.text" },
  ];

  const MANUAL_COMMAND = "./run.sh";

  function openManual(step = state.manualStep || 0) {
    state.manualStep = clamp(step, 0, MANUAL_STEPS.length - 1);
    const el = $("#manual");
    if (!el) return;
    if (el.hidden) state.manualReturn = document.activeElement;
    renderManual();
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add("open");
    store.set("tourSeen", true);
    setTimeout(() => $(".manual-close")?.focus(), 40);
  }

  function closeManual() {
    const el = $("#manual");
    if (!el) return;
    el.classList.remove("open");
    const back = state.manualReturn;
    state.manualReturn = null;
    setTimeout(() => {
      if (el.classList.contains("open")) return;
      el.hidden = true;
      if (back && back.isConnected) back.focus();
    }, 220);
  }

  function manualChecks() {
    const S = state.snap;
    const tools = S ? portTools() : [];
    return [
      { ok: Boolean(S), label: tr("manual.check.server") },
      { ok: Boolean(S && (S.meta?.sources || []).some((s) => s.key === "router" && s.status === "ok")), label: tr("manual.check.source") },
      { ok: Boolean(S && Number(S.today?.requests) > 0), label: tr("manual.check.calls") },
      { ok: tools.some((t) => t.installed), label: tr("manual.check.tool") },
      { ok: Boolean(S && (S.providers || []).length > 0), label: tr("manual.check.first") },
    ];
  }

  function manualVisual(step) {
    if (step === 0) {
      return `<div class="m-roles">
        <div class="m-role tool"><i class="lg lg-tool"></i><b>${esc(tr("port.roleToolName"))}</b><span>${esc(tr("manual.roleTool"))}</span></div>
        <span class="m-arrow">→</span>
        <div class="m-role source"><i class="lg lg-source"></i><b>9router</b><span>${esc(tr("manual.roleSource"))}</span></div>
        <span class="m-arrow">→</span>
        <div class="m-role ai"><i class="lg lg-ai"></i><b>${esc(tr("port.roleAiName"))}</b><span>${esc(tr("manual.roleAi"))}</span></div>
      </div>`;
    }
    if (step === 1) {
      return `<div class="m-code"><code>${esc(MANUAL_COMMAND)}</code><button data-act="manual-copy">${esc(tr("manual.copy"))}</button></div>
        <div class="m-note">${esc(tr("manual.sourceNote"))}</div>
        <div class="m-flow-line"><span>127.0.0.1:8770</span><i></i><span>9router</span></div>`;
    }
    if (step === 2) {
      return `<div class="m-routes">
        <div class="m-route">
          <span class="m-route-tag">${esc(tr("manual.routePrimary"))}</span>
          <div class="m-chain">
            <div><i class="lg lg-tool"></i><b>${esc(tr("manual.chainTool"))}</b></div>
            <span>→</span>
            <div><i class="lg lg-source"></i><b>9router</b></div>
            <span>→</span>
            <div><i class="lg lg-ai"></i><b>${esc(tr("manual.chainAi"))}</b></div>
          </div>
        </div>
        <div class="m-route alt">
          <span class="m-route-tag">${esc(tr("manual.routeFallback"))}</span>
          <div class="m-chain compact">
            <div class="m-pill">9router</div>
            <span>→</span>
            <div class="m-pill">${esc(tr("manual.routeNext"))}</div>
            <span>→</span>
            <div class="m-pill log">${esc(tr("manual.routeLog"))}</div>
          </div>
        </div>
      </div>
      <div class="m-note">${esc(tr("manual.routeNote"))}</div>`;
    }
    if (step === 3) {
      const checks = manualChecks();
      return `<div class="m-checks">${checks.map((c) => `<div class="${c.ok ? "ok" : ""}"><i>${c.ok ? "✓" : "·"}</i><span>${esc(c.label)}</span></div>`).join("")}</div>
        <button class="btn ghost m-refresh" data-act="refresh">${esc(tr("manual.refresh"))}</button>`;
    }
    return `<div class="m-wings">
      ${["fluxo", "sessoes", "ajuda"].map((k) => `<button data-act="wing" data-key="${k}"><b>${esc(tr(`nav.${k}`))}</b><span>${esc(tr(`guide.${k}`))}</span><i>→</i></button>`).join("")}
    </div>`;
  }

  function renderManual() {
    const body = $("#manualBody");
    if (!body) return;
    const step = state.manualStep;
    const item = MANUAL_STEPS[step];
    const checks = manualChecks();
    const done = checks.filter((c) => c.ok).length;
    $("#manualEyebrow").textContent = `${tr("manual.eyebrow")} · ${step + 1}/${MANUAL_STEPS.length}`;
    body.innerHTML = `
      <div class="manual-grid">
        <nav class="manual-steps" aria-label="${esc(tr("manual.stepsLabel"))}">
          ${MANUAL_STEPS.map((s, i) => `<button class="manual-step${i === step ? " on" : ""}${checks[i]?.ok ? " done" : ""}" data-act="manual-step" data-step="${i}" aria-current="${i === step}" aria-label="${esc(tr(s.titleKey))}">
            <i>${s.icon}</i><span><b>${esc(tr(s.titleKey))}</b><em>${esc(tr(`manual.step${i + 1}.short`))}</em></span>
          </button>`).join("")}
          <div class="manual-progress"><span>${esc(tr("manual.liveProgress"))}</span><b>${done}/${checks.length}</b><div><i style="width:${(done / checks.length) * 100}%"></i></div></div>
        </nav>
        <section class="manual-stage">
          <span class="manual-stage-kicker">${esc(tr("manual.step"))} ${String(step + 1).padStart(2, "0")}</span>
          <h3>${esc(tr(item.titleKey))}</h3>
          <p>${esc(tr(item.textKey))}</p>
          <div class="manual-visual">${manualVisual(step)}</div>
          <div class="manual-foot">
            <button class="btn ghost" data-act="manual-prev"${step === 0 ? " disabled" : ""}>← ${esc(tr("common.back"))}</button>
            <span>${esc(tr("manual.privacy"))}</span>
            <button class="btn primary" data-act="${step === MANUAL_STEPS.length - 1 ? "manual-close" : "manual-next"}">${esc(step === MANUAL_STEPS.length - 1 ? tr("manual.finish") : tr("common.next"))} ${step === MANUAL_STEPS.length - 1 ? "" : "→"}</button>
          </div>
        </section>
      </div>`;
  }

  function manualMove(delta) {
    state.manualStep = clamp(state.manualStep + delta, 0, MANUAL_STEPS.length - 1);
    renderManual();
  }

  /* ---------------------------------------------------------- chart */

  function chartBuckets() {
    const S = state.snap;
    if (state.mode === "days") {
      const days = (S.series || []).slice(-7);
      return {
        kind: "days",
        items: days.map((d) => ({
          key: d.date, label: d.label, title: `${longDate(d.date)} · ${d.label}`,
          tokens: d.tokens, cost: d.cost, requests: d.requests, providers: d.providers || {}, date: d.date,
        })),
      };
    }
    const day = state.selectedDay || S.today.date;
    const hours = S.hours?.[day] || [];
    const dayMeta = S.series?.find((d) => d.date === day) || S.today;
    return {
      kind: "hours",
      day,
      dayMeta,
      items: Array.from({ length: 24 }, (_, h) => {
        const row = hours.find((x) => x.hour === h) || { hour: h, tokens: 0, cost: 0, requests: 0, providers: {} };
        return {
          key: h, label: `${String(h).padStart(2, "0")}h`,
          title: `${String(h).padStart(2, "0")}:00 — ${String((h + 1) % 24).padStart(2, "0")}:00 · ${dayMeta?.label || day}`,
          tokens: row.tokens, cost: row.cost, requests: row.requests, providers: row.providers || {}, date: day, hour: h,
        };
      }),
    };
  }

  function renderChart() {
    const S = state.snap;
    const svg = $("#chart");
    if (!S || !svg) return;
    const bucket = chartBuckets();
    state.chartItems = bucket.items;
    state.bucketKind = bucket.kind;
    const focus = state.focus;
    const values = bucket.items.map((it) => focus ? (it.providers?.[focus]?.tokens || 0) : it.tokens);
    const max = Math.max(1, ...values);
    const W = 612, H = 178, L = 30, R = 6, T = 10, B = 18, PW = W - L - R, PH = H - T - B;
    const n = bucket.items.length;
    const gap = bucket.kind === "hours" ? 7 : 12;
    const bw = Math.max(2, (PW - gap * (n - 1)) / n);
    let out = "";
    for (let i = 0; i <= 3; i++) {
      const y = T + (PH * i) / 3;
      out += `<line class="chart-grid" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}"/>`;
      out += `<text class="chart-axis" x="${L - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${compact(max * (1 - i / 3))}</text>`;
    }
    bucket.items.forEach((it, idx) => {
      const x = L + idx * (bw + gap);
      const entries = Object.entries(it.providers || {})
        .filter(([k, v]) => (v?.tokens || 0) > 0 && (!focus || k === focus))
        .sort((a, b) => (a[1]?.tokens || 0) - (b[1]?.tokens || 0));
      let y = T + PH;
      entries.forEach(([k, v]) => {
        const h = PH * ((v.tokens || 0) / max);
        y -= h;
        out += `<rect class="bar-seg" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(1, h).toFixed(2)}" rx="${bw > 7 ? 2 : 1}" fill="${provColor(k)}"/>`;
      });
      out += `<rect class="bar-col" data-i="${idx}" x="${(x - gap / 2).toFixed(2)}" y="${T}" width="${(bw + gap).toFixed(2)}" height="${PH}" fill="transparent"/>`;
      if (bucket.kind === "hours" && idx % 3 === 0) {
        out += `<text class="chart-axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${it.label}</text>`;
      }
      if (bucket.kind === "days") {
        out += `<text class="chart-axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(it.label.slice(0, 5))}</text>`;
      }
    });
    if (max <= 1) {
      out += `<text class="chart-empty" x="${L + PW / 2}" y="${T + PH / 2}" text-anchor="middle">${esc(tr("atlas.noData"))}</text>`;
    } else {
      const peak = values.indexOf(max);
      if (peak >= 0) {
        const px = L + peak * (bw + gap) + bw / 2;
        const cy = T + PH * 0.42;
        const rx = Math.max(11, bw * 0.95);
        const ry = Math.max(16, PH * 0.34);
        const anchor = px > W - 92 ? "end" : "start";
        const tx = anchor === "end" ? px - rx - 4 : px + rx + 4;
        out += `<g class="chart-scrawl" aria-hidden="true">
          <ellipse cx="${px.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(-5 ${px.toFixed(1)} ${cy.toFixed(1)})"/>
          <ellipse cx="${(px + 1.5).toFixed(1)}" cy="${(cy - 1).toFixed(1)}" rx="${(rx + 2).toFixed(1)}" ry="${(ry + 1.5).toFixed(1)}" opacity=".4"/>
          <text x="${tx.toFixed(1)}" y="${(cy - ry - 4).toFixed(1)}" text-anchor="${anchor}">PICO</text>
        </g>`;
      }
    }
    if (bucket.kind === "hours" && bucket.day === S.today.date) {
      const now = new Date();
      const frac = now.getHours() + now.getMinutes() / 60;
      const x = L + clamp(frac, 0, 23) * (bw + gap) + bw / 2;
      out += `<line class="chart-now" x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${T + PH}"/>`;
      out += `<text class="chart-nowlabel" x="${x > W - 44 ? x - 4 : x + 4}" y="${T + 7}" text-anchor="${x > W - 44 ? "end" : "start"}">${esc(tr("atlas.now"))}</text>`;
    }
    svg.innerHTML = out;
    bindChartHover(svg);

    const title = $("#chartTitle");
    const sub = $("#chartSub");
    const focusName = focus ? provName(focus) : "";
    if (bucket.kind === "hours") {
      const isToday = bucket.day === S.today.date;
      title.textContent = isToday ? tr("atlas.chartTitle") : tr("atlas.hourByHour", { day: bucket.dayMeta?.label || bucket.day });
      const parts = [tr("common.periodCalls", { n: int(bucket.dayMeta?.requests || 0) }), money(bucket.dayMeta?.cost || 0), `${compact(bucket.dayMeta?.tokens || 0)} ${tr("common.tokens")}`];
      if (focus) parts.unshift(tr("atlas.filter", { name: focusName }));
      sub.textContent = parts.join(" · ");
    } else {
      title.textContent = tr("atlas.weekTitle");
      const total = bucket.items.reduce((a, b) => a + b.tokens, 0);
      const cost = bucket.items.reduce((a, b) => a + b.cost, 0);
      sub.textContent = `${compact(total)} ${tr("common.tokens")} · ${money(cost)}${focus ? ` · ${tr("atlas.filter", { name: focusName })}` : ""}`;
    }

    $$(".seg button", $("#chartSeg")).forEach((b) => b.classList.toggle("sel", b.dataset.mode === state.mode));
  }

  function bindChartHover(svg) {
    const wrap = $(".chart-wrap");
    let tip = $(".chart-tip", wrap);
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "chart-tip";
      wrap.appendChild(tip);
    }
    const show = (idx, ev) => {
      const item = state.chartItems[idx];
      if (!item) return;
      const entries = Object.entries(item.providers || {}).filter(([, v]) => (v?.tokens || 0) > 0).sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
      const rows = state.focus ? entries.filter(([k]) => k === state.focus) : entries;
      tip.innerHTML = `<div class="ct-title">${esc(item.title)}</div>
        ${rows.map(([k, v]) => `<div class="ct-row"><i style="background:${provColor(k)}"></i><span>${esc(provName(k))}</span><b>${compact(v.tokens)}</b></div>`).join("") || `<div class="ct-row"><span>sem consumo</span><b>0</b></div>`}
        <div class="ct-total"><span>${int(item.requests)} chamadas</span><b>${money(item.cost)}</b></div>`;
      const r = wrap.getBoundingClientRect();
      tip.style.left = `${clamp(ev.clientX - r.left, 80, r.width - 80)}px`;
      tip.style.top = `${ev.clientY - r.top}px`;
      tip.classList.add("on");
    };
    svg.onmouseover = (ev) => {
      const hit = ev.target.closest?.("[data-i]");
      if (hit) show(Number(hit.dataset.i), ev);
    };
    svg.onmousemove = (ev) => {
      const hit = ev.target.closest?.("[data-i]");
      if (hit) show(Number(hit.dataset.i), ev);
    };
    svg.onmouseleave = () => tip.classList.remove("on");
    svg.onclick = (ev) => {
      const hit = ev.target.closest?.("[data-i]");
      if (hit) openBucketDrawer(Number(hit.dataset.i));
    };
  }

  function renderTimeline() {
    const S = state.snap;
    const days = (S.series || []).slice(-7);
    const max = Math.max(1, ...days.map((d) => d.tokens));
    $("#timeline").innerHTML = days.map((d) => {
      const on = state.mode === "today" && d.date === state.selectedDay;
      return `<button class="tl-day${on ? " on" : ""}" data-act="day" data-date="${esc(d.date)}" title="${esc(longDate(d.date))} · ${compact(d.tokens)} tokens · ${money(d.cost)}" aria-pressed="${on}">
        <span class="tl-top"><span>${esc(d.weekday)}</span><span>${esc(d.label.slice(0, 5))}</span></span>
        <span class="tl-bar"><i style="width:${Math.max(2, (d.tokens / max) * 100)}%"></i></span>
      </button>`;
    }).join("");
    const past = state.mode === "today" && state.selectedDay !== S.today.date;
    $("#timeChip").hidden = !past;
    if (past) {
      const d = S.series.find((x) => x.date === state.selectedDay);
      $("#timeChipText").textContent = `${d?.label || state.selectedDay} · ${compact(d?.tokens || 0)} tokens`;
    }
  }

  function selectDay(date) {
    state.mode = "today";
    state.selectedDay = date;
    renderTimeline();
    renderChart();
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === "days") {
      $("#timeChip").hidden = true;
    } else {
      renderTimeline();
    }
    renderChart();
  }

  /* ---------------------------------------------------------- quests + xp */

  function computeQuests() {
    const S = state.snap;
    const t = S.totals;
    const today = S.today;
    const freeShare = t.tokens ? ((S.insights?.freeTokensEstimate || 0) / t.tokens) * 100 : 0;
    const reviewed = Math.min(2, state.reviewed.size);
    const dailyCap = 1; // US$ 1/dia, a base em que o 9router registra custo
    return [
      { id: "cache", title: tr("quests.cacheTitle"), sub: tr("quests.cacheSub", { pct: pct(t.cacheHit) }), progress: clamp((t.cacheHit / 65) * 100), done: t.cacheHit >= 65, xp: 60 },
      { id: "budget", title: tr("quests.budgetTitle", { limit: money(dailyCap) }), sub: tr("quests.budgetSub", { cost: money(today.cost) }), progress: clamp(today.cost <= dailyCap ? 100 : (dailyCap / today.cost) * 100), done: today.cost <= dailyCap, xp: 50 },
      { id: "errors", title: tr("quests.errorsTitle"), sub: tr("quests.errorsSub", { n: reviewed }), progress: clamp((reviewed / 2) * 100), done: reviewed >= 2, xp: 70 },
      { id: "free", title: tr("quests.freeTitle"), sub: tr("quests.freeSub", { pct: pct(freeShare) }), progress: clamp((freeShare / 25) * 100), done: freeShare >= 25, xp: 60 },
      { id: "explore", title: tr("quests.exploreTitle"), sub: tr("quests.exploreSub", { n: Math.min(3, state.visited.size) }), progress: clamp((state.visited.size / 3) * 100), done: state.visited.size >= 3, xp: 30 },
    ];
  }

  function renderQuests() {
    const S = state.snap;
    if (!S) return;
    const quests = computeQuests();
    state.quests = quests;
    $("#quests").innerHTML = quests.slice(0, 4).map((q) => `<div class="quest${q.done ? " done" : ""}">
      <span class="q-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>
      <span class="q-body">
        <span class="q-top"><b>${esc(q.title)}</b><span>+${q.xp} XP</span></span>
        <span class="q-sub">${esc(q.sub)}</span>
        <span class="q-bar"><i style="width:${q.progress.toFixed(1)}%"></i></span>
      </span>
    </div>`).join("");
    const doneNow = new Set(quests.filter((q) => q.done).map((q) => q.id));
    if (state.ready) {
      for (const id of doneNow) {
        if (!state.doneSet.has(id)) {
          const q = quests.find((x) => x.id === id);
          confetti();
          toast(`Missão concluída: ${q.title} · +${q.xp} XP`);
        }
      }
    }
    state.doneSet = doneNow;
    renderXP();
  }

  function xpTotals() {
    const base = state.snap ? state.snap.totals.activeDays * 15 : 0;
    const completed = state.quests.filter((q) => q.done).reduce((s, q) => s + q.xp, 0);
    const reviewed = Math.min(2, state.reviewed.size) * 10;
    return { xp: base + completed + reviewed, today: xpToday() };
  }

  function levelFor(xp) {
    const levels = [0, 100, 220, 380, 580, 820, 1100, 1420, 1800, 2220];
    const names = Array.from({ length: 10 }, (_, i) => tr(`levels.${i}`));
    let idx = 0;
    for (let i = 0; i < levels.length; i++) if (xp >= levels[i]) idx = i;
    const next = levels[Math.min(idx + 1, levels.length - 1)] || levels[idx] + 500;
    const span = Math.max(1, next - levels[idx]);
    return { level: idx + 1, name: names[idx], progress: clamp(((xp - levels[idx]) / span) * 100), next, current: levels[idx] };
  }

  function renderXP() {
    const { xp, today } = xpTotals();
    const lv = levelFor(xp);
    $("#lvlBadge").textContent = lv.level;
    $("#railLvl").textContent = lv.level;
    $("#levelName").textContent = tr("quests.level", { n: lv.level, name: lv.name });
    $("#xpVal").textContent = `${int(xp)} / ${int(lv.next)} XP`;
    $("#xpBar").style.width = `${lv.progress}%`;
    $("#xpRing").style.strokeDashoffset = `${94.2 * (1 - lv.progress / 100)}`;
    $("#xpChip").textContent = `${today} XP hoje`;
    $("#chipXpText").textContent = `+${today} XP hoje`;
    const railLvlName = $("#railLvlName");
    const railXpText = $("#railXpText");
    if (railLvlName) railLvlName.textContent = lv.level;
    if (railXpText) railXpText.textContent = `${int(xp)} / ${int(lv.next)} XP`;
    $("#railXp").title = `Nível ${lv.level} · ${lv.name} · ${int(xp)} XP`;
  }

  /* ---------------------------------------------------------- cockpit */

  function monthUsage() {
    const m = state.snap?.month;
    if (!m?.month) return null;
    return {
      month: m.month,
      cost: Number(m.cost) || 0,
      byProvider: m.byProvider || {},
      elapsed: m.elapsed || 1,
      daysInMonth: m.days_in_month || 30,
      projected: Number(m.projected) || 0,
      days: m.active_days || 0,
    };
  }

  function budgetStatus(spent, limit) {
    if (!limit) return null;
    const used = Number(spent) || 0;
    const ratio = (used / limit) * 100;
    const threshold = state.budgets.threshold;
    const tone = ratio >= 100 ? "over" : ratio >= threshold ? "warn" : "ok";
    return { pct: ratio, tone, left: limit - used };
  }

  function localizeAlert(alert) {
    if (alert.kind !== "budget") return alert;
    const isGlobal = alert.budget === "global";
    return {
      ...alert,
      title: isGlobal
        ? tr("alert.budgetTotalTitle", { pct: dec(alert.pct, 0) })
        : tr("alert.budgetTitle", { provider: provName(alert.budget), pct: dec(alert.pct, 0) }),
      detail: tr("alert.budgetDetail", { used: money(alert.spent), limit: money(alert.limit), month: tr("budget.month") }),
    };
  }

  function allAlerts() {
    return (state.snap?.alerts || []).map(localizeAlert);
  }

  function renderCockpit() {
    const S = state.snap;
    if (!S) return;
    const panes = $("#panes");
    panes.innerHTML = paneAgora() + paneProviders() + paneErrors() + paneTips();
    switchTab(state.tab || "agora", true);
  }

  function paneAgora() {
    const S = state.snap;
    const t = S.today;
    const q = S.quota?.codex || {};
    const claude = S.quota?.claude || {};
    const quotas = [];
    if (q.available) {
      quotas.push({ key: "codex-week", label: `Codex · ${tr("sun.week")}`, free: q.week_free, reset: q.week_reset, color: "#2f9e6b", meta: tr("common.resetIn", { v: until(q.week_reset) }) });
      quotas.push({ key: "codex-session", label: `Codex · ${tr("sun.window5h")}`, free: q.session_free, reset: q.session_reset, color: "#37a6c8", meta: tr("common.resetIn", { v: until(q.session_reset) }) });
    }
    if (claude.available) {
      quotas.push({ key: "claude-week", label: `Claude · ${tr("sun.week")}`, free: claude.week_free, reset: claude.week_reset, color: "#d97757", meta: claude.credit_free != null ? tr("cockpit.creditFree", { pct: pct(claude.credit_free) }) : tr("sun.window5h") });
    }
    const actions = recommendedActions();
    return `<div class="pane" data-pane="agora">
      <div class="action-strip">
        <div class="as-head"><b>${esc(tr("cockpit.actionTitle"))}</b><span>${esc(tr("cockpit.actionSub"))}</span></div>
        ${actions.map((a) => `<button class="as-item" data-act="${a.act || "wing"}"${a.wing ? ` data-key="${a.wing}"` : ""}>
          <span class="as-ico">→</span>
          <span class="as-copy"><b>${esc(a.label)}</b><span>${esc(a.detail)}</span></span>
          <em>${esc(tr("action.view"))}</em>
        </button>`).join("")}
      </div>
      ${budgetStrip()}
      <div class="now-grid">
        <div class="now-stat accent"><span>${esc(tr("cockpit.tokensToday"))}</span><b>${compact(t.tokens)}</b><em>${tr("cockpit.callsN", { n: int(t.requests) })}</em></div>
        <div class="now-stat"><span>${esc(tr("cockpit.costToday"))}</span><b>${money(t.cost)}</b><em>${tr("cockpit.perCall", { v: money(S.insights?.costPerReq || 0) })}</em></div>
        <div class="now-stat"><span>${esc(tr("cockpit.cacheHit"))}</span><b>${pct(S.totals.cacheHit)}</b><em>${tr("cockpit.reused", { v: compact(t.cached) })}</em></div>
        <div class="now-stat"><span>${esc(tr("cockpit.topModel"))}</span><b style="font-size:11px;line-height:1.3">${esc(modelName(S.insights?.topModel?.model))}</b><em>${tr("cockpit.share", { pct: pct(S.insights?.topModel?.share || 0) })}</em></div>
      </div>
      <div class="quota-list">
        ${quotas.map((x) => `<button class="quota-row" style="--pc:${x.color}" data-act="quota" data-key="${esc(x.key)}" title="Ver detalhes da cota">
          <span class="qr-dot"></span>
          <span class="qr-main">
            <span class="qr-top"><b>${esc(x.label)}</b><span>${pct(x.free, 0)} ${esc(tr("common.free"))}</span></span>
            <span class="qr-bar"><i style="width:${clamp(x.free)}%"></i></span>
          </span>
          <span class="qr-meta">${esc(x.meta)}</span>
        </button>`).join("")}
        ${S.quota?.google && !S.quota.google.available ? `<button class="quota-row" style="--pc:#8b7ad4" data-act="quota" data-key="google"><span class="qr-dot"></span><span class="qr-main"><span class="qr-top"><b>Google · ${esc(tr("common.quota"))}</b><span>—</span></span><span class="qr-bar"><i style="width:100%;background:repeating-linear-gradient(115deg,rgba(139,122,212,.4) 0 5px,rgba(139,122,212,.12) 5px 10px)"></i></span></span><span class="qr-meta">${esc(tr("common.noToken"))}</span></button>` : ""}
      </div>
    </div>`;
  }

  function paneProviders() {
    const S = state.snap;
    const rows = (S.providers || []).map((p) => {
      const quota = p.provider === "codex" ? S.quota?.codex?.week_free : p.provider === "claude" ? S.quota?.claude?.week_free : null;
      const slo = (S.slo?.providers || []).find((x) => x.provider === p.provider);
      const meta = slo ? `${int(p.requests)} chamadas · p95 ${latency(slo.p95)} · ${pct(slo.errorRate, 0)} erro` : `${int(p.requests)} chamadas · ${compact(p.tokens)} tokens`;
      return `<button class="cockpit-row" style="--pc:${provColor(p.provider)}" data-act="provider-detail" data-key="${esc(p.provider)}">
        <span class="cr-dot"></span>
        <span class="cr-main"><b>${esc(provName(p.provider))}</b><span>${esc(meta)}</span></span>
        <span class="cr-val"><b>${pct(p.share, 0)}</b><span>${money(p.cost)}</span></span>
        <span class="cr-status"></span>
      </button>`;
    }).join("");
    const conns = (S.connections || []).filter((c) => !(S.providers || []).some((p) => p.provider === c.provider));
    return `<div class="pane" data-pane="provedores">
      ${rows}
      ${conns.length ? `<div style="margin:9px 6px 3px;font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700">Conexões sem uso no período</div>` : ""}
      ${conns.map((c) => {
        const ok = c.status === "active";
        return `<button class="cockpit-row" style="--pc:${provColor(c.provider)}" data-act="provider-detail" data-key="${esc(c.provider)}">
          <span class="cr-dot" style="opacity:${ok ? 1 : 0.45}"></span>
          <span class="cr-main"><b>${esc(provName(c.provider))}</b><span>${esc(c.auth || "conexão")} · ${esc(maskEmail(c.name))}</span></span>
          <span class="cr-val"><b style="font-size:8.5px;color:${ok ? "#1D6F52" : "#8A5C0F"}">${ok ? "ativa" : c.errorCode ? `erro ${c.errorCode}` : "off"}</b><span>${esc(c.plan || "—")}</span></span>
          <span class="cr-status ${ok ? "" : "bad"}"></span>
        </button>`;
      }).join("")}
    </div>`;
  }

  function paneErrors() {
    const S = state.snap;
    const errors = (S.errors || []).slice(0, 6);
    return `<div class="pane" data-pane="erros">
      ${errors.length ? errors.map((e, i) => {
        const reviewed = state.reviewed.has(`${e.provider}|${e.model}|${e.diagnosis?.title}`);
        return `<div class="err-item ${e.diagnosis?.tone === "bad" ? "bad" : "warn"}">
          <div class="err-head"><span class="err-dot"></span><b>${esc(provName(e.provider))} · ${esc(e.diagnosis?.title || "Erro")}</b><span>${e.count}×</span></div>
          <div class="err-body">${esc(e.message)}</div>
          <div class="err-actions">
            <button class="btn ghost" data-act="error-copy" data-i="${i}">${reviewed ? "✓ revisado" : "copiar prompt"}</button>
            <button class="btn primary" data-act="error-detail" data-i="${i}">detalhes</button>
          </div>
        </div>`;
      }).join("") : `<div class="cockpit-empty">Nenhum erro no período. O céu está limpo.</div>`}
    </div>`;
  }

  function paneTips() {
    const S = state.snap;
    const tips = [];
    const q = S.quota?.codex;
    if (q?.available && q.week_free > 40) tips.push({ tone: "ok", icon: "✦", title: "Folga confortável no Codex", body: `${pct(q.week_free, 0)} livre; dá para reservar modelos maiores para arquitetura.`, q: "Quanta folga eu tenho e como usar o excedente?" });
    if (S.totals.cacheHit > 60) tips.push({ tone: "ok", icon: "⚡", title: "Cache está segurando o custo", body: `${pct(S.totals.cacheHit)} de acerto. Repita contexto e sessões para manter.`, q: "Como manter o cache alto?" });
    tips.push({ tone: "ok", icon: "◈", title: "Comparar com outra IA", body: "O Manual da Frota mostra para que serve cada provedor conectado.", q: "Qual IA devo usar para cada tarefa?" });
    (S.suggestions || []).slice(0, 3).forEach((s) => tips.push({ tone: s.level === "warn" ? "warn" : "ok", icon: s.level === "warn" ? "!" : "→", title: s.title, body: String(s.detail).slice(0, 120), q: `Como resolvo: ${s.title}?` }));
    return `<div class="pane" data-pane="dicas">
      ${tips.slice(0, 6).map((t) => `<button class="tip-item ${t.tone === "warn" ? "warn" : ""}" data-act="ask" data-q="${esc(t.q)}">
        <span class="tip-ico">${t.icon}</span>
        <span class="tip-body"><b>${esc(t.title)}</b><span>${esc(t.body)}</span></span>
      </button>`).join("")}
    </div>`;
  }

  function switchTab(tab, silent = false) {
    state.tab = tab || "agora";
    $$(".tabs .tab").forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $$("#panes .pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === state.tab));
    const titles = { agora: "Agora", provedores: "Provedores", erros: "Erros", dicas: "Dicas" };
    $("#cockpitTitle").textContent = titles[state.tab] || "Agora";
    if (!silent) {
      const pane = $(".pane.active", $("#panes"));
      if (pane) pane.scrollTop = 0;
    }
  }

  /* ---------------------------------------------------------- band + ticker + pip */

  function renderBand() {
    const S = state.snap;
    const recent = (S.recent || []).slice(0, 6);
    $("#liveSub").textContent = tr("atlas.liveSub", { n: int(S.totals.requests), ago: ago(S.meta.router_age) });
    $("#feed").innerHTML = recent.map((r) => `<div class="feed-row" style="--pc:${provColor(r.provider)}">
      <span class="feed-time">${esc(r.time)}</span>
      <span class="feed-dot"></span>
      <span class="feed-main"><b title="${esc(r.model)}">${esc(modelName(r.model))}</b><small>${esc(provName(r.provider))}</small></span>
      <span class="feed-tok">${compact((r.input || 0) + (r.output || 0))}</span>
      <span class="feed-cost">${money(r.cost)}</span>
    </div>`).join("");

    const alerts = allAlerts();
    $("#radarCount").textContent = alerts.length;
    const bad = alerts.filter((a) => a.tone === "bad").length;
    const warn = alerts.filter((a) => a.tone === "warn").length;
    const critical = bad === 1 ? tr("atlas.criticalOne") : tr("atlas.criticalMany", { n: bad });
    const warnings = warn === 1 ? tr("atlas.warnOne") : tr("atlas.warnMany", { n: warn });
    $("#radarSub").textContent = `${critical} · ${warnings}`;
    const shown = Math.min(4, alerts.length);
    $("#radar").innerHTML = alerts.slice(0, shown).map((a, i) => `<button class="radar-item ${esc(a.tone)}" data-act="radar" data-i="${i}" title="${esc(a.detail)}">
      <span class="radar-ico">${a.tone === "bad" ? "!" : a.tone === "warn" ? "~" : "→"}</span>
      <span class="radar-body"><b>${esc(a.title)}</b><span>${esc(a.detail)}</span></span>
    </button>`).join("") + (alerts.length > shown ? `<button class="radar-more" data-act="wing" data-key="ajuda">${esc(tr("atlas.radarMore", { n: alerts.length - shown }))}</button>` : "");
  }

  function renderTicker() {
    const S = state.snap;
    const q = S.quota?.codex;
    const items = [
      { html: `<b>${compact(S.today.tokens)}</b> tokens hoje`, wing: "fluxo" },
      { html: `<b>${money(S.today.cost)}</b> hoje`, wing: "fluxo" },
      { html: `<b>${pct(S.totals.cacheHit)}</b> cache`, wing: "fluxo" },
      { html: `<b>${esc(provName(S.insights?.topProvider?.provider))}</b> lidera com ${pct(S.insights?.topProvider?.share || 0)}`, wing: "fluxo" },
      q?.available ? { html: `<b>${pct(q.week_free, 0)}</b> de folga no Codex`, wing: "fluxo" } : null,
      { html: `<b>${(S.errors || []).length}</b> diagnósticos abertos`, wing: "ajuda" },
      { html: `<b>${S.qoder?.sessions?.length || 0}</b> sessões Qoder`, wing: "sessoes" },
      { html: `<b>${S.qoder?.skills?.total || 0}</b> skills carregadas`, wing: "oficina" },
      { html: `<b>${compact(S.insights?.freeTokensEstimate || 0)}</b> tokens grátis`, wing: "biblioteca" },
      { html: `manual da frota: <b>${Object.keys(KNOWLEDGE).length}</b> IAs`, wing: "biblioteca" },
      { html: `headroom <b>${S.router?.headroom?.online ? "online" : "offline"}</b>`, wing: "ajuda" },
    ].filter(Boolean);
    const html = items.map((x) => `<span class="tick" data-act="wing" data-key="${x.wing}">${x.html}</span>`).join("");
    $("#tickerRow").innerHTML = html + html;
    $("#tickerHint").textContent = "v0.1 · 127.0.0.1";
  }

  function pipTips() {
    const S = state.snap;
    if (!S) return ["Lendo seus dados locais…"];
    const q = S.quota?.codex;
    const tips = [];
    if (q?.available) tips.push(`A janela do Codex tem ${pct(q.week_free, 0)} de folga. Quer um plano de 3 ações?`);
    tips.push(`Hoje foram ${compact(S.today.tokens)} tokens. ${pct(S.totals.cacheHit)} veio do cache.`);
    if ((S.errors || []).length) tips.push(`Tem ${S.errors.length} erros diagnosticados. Posso montar o prompt de correção.`);
    tips.push("Clique em um balão para ver o manual daquela IA e filtrar o gráfico.");
    tips.push("Pergunte “qual IA usar para esta tarefa?” e eu comparo a frota.");
    return tips;
  }

  function renderPipTip() {
    const tips = pipTips();
    const tip = $("#pipTip");
    const pip = $("#pipCompanion");
    if (!tip || !pip) return;
    const text = tips[state.pipIndex % tips.length];
    tip.textContent = text;
    pip.setAttribute("aria-label", `Pip — abrir assistente. ${text}`);
  }

  /* ---------------------------------------------------------- clocks */

  function startClocks() {
    setInterval(() => {
      if (!state.snap) return;
      updateAgeLabels();
      const age = state.snap.meta.router_age + (Date.now() - state.loadedAt) / 1000;
      $("#chipLiveText").textContent = `coleta ${ago(age)}`;
      $("#livePill").classList.toggle("stale", age > 1800);
      if ($("#cockpitLive")) $("#cockpitLive").textContent = state.busy ? "coletando" : "ao vivo";
      renderPortHud();
    }, 15000);
    setInterval(() => {
      if (state.sunPaused || !state.snap) return;
      nextSun(false);
    }, 7600);
    setInterval(() => {
      if (!state.snap || state.busy) return;
      if (Date.now() - state.loadedAt > 60000) loadSnapshot();
    }, 70000);
  }

  function updateAgeLabels() {
    if (!state.snap) return;
    const age = state.snap.meta.router_age + (Date.now() - state.loadedAt) / 1000;
    $("#chipLive").title = `Última leitura do 9router: ${ago(age)}`;
  }

  /* ---------------------------------------------------------- refresh / light */

  async function refreshData() {
    if (state.busy) return;
    state.busy = true;
    const btn = $("#refreshBtn");
    btn.classList.add("busy");
    $("#liveLabel").textContent = "coletando";
    $("#livePill").classList.add("busy");
    $("#cockpitLive").textContent = "coletando";
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      applySnapshot(data.snapshot);
      confetti();
      toast(`Dados atualizados em ${data.seconds}s · ${compact(data.snapshot.today.tokens)} tokens hoje`);
    } catch (err) {
      toast(`Falha ao atualizar: ${err.message}`, "bad");
      $("#livePill").classList.add("stale");
    } finally {
      state.busy = false;
      btn.classList.remove("busy");
      $("#livePill").classList.remove("busy");
      $("#cockpitLive").textContent = "ao vivo";
      renderTopbar();
    }
  }

  function toggleLight() {
    const dusk = app.dataset.light !== "dusk";
    app.dataset.light = dusk ? "dusk" : "day";
    $("#lightLabel").textContent = tr(dusk ? "topbar.dusk" : "topbar.day");
    store.set("light", dusk ? "dusk" : "day");
    toast(dusk ? "Modo crepúsculo · constelações ligadas" : "Modo dia · céu aberto");
  }

  /* ---------------------------------------------------------- toast / confetti / copy */

  function toast(message, tone = "ok") {
    const wrap = $("#toasts");
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    const icon = tone === "bad" ? "!" : tone === "warn" ? "~" : "✓";
    el.innerHTML = `<span class="t-ico">${icon}</span><span>${esc(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 320);
    }, 3400);
  }

  function confetti() {
    const wrap = $("#confetti");
    if (!wrap) return;
    const colors = ["#ff4b2b", "#c8f169", "#3e6bff", "#0f1a15", "#f4f0e5"];
    for (let i = 0; i < 34; i++) {
      const p = document.createElement("i");
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDelay = `${Math.random() * 0.25}s`;
      p.style.animationDuration = `${1.2 + Math.random() * 0.7}s`;
      p.style.transform = `rotate(${Math.random() * 180}deg)`;
      wrap.appendChild(p);
      setTimeout(() => p.remove(), 2200);
    }
  }

  async function copyText(text, label = "Copiado") {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast(label);
      return true;
    } catch {
      toast("Não foi possível copiar neste navegador", "bad");
      return false;
    }
  }

  /* ---------------------------------------------------------- delegated actions */

  const ACTIONS = {};
  const act = (name, fn) => { ACTIONS[name] = fn; };

  function bindDelegates() {
    app.addEventListener("click", (ev) => {
      const el = ev.target.closest?.("[data-act]");
      if (!el) return;
      const fn = ACTIONS[el.dataset.act];
      if (!fn) return;
      ev.preventDefault();
      ev.stopPropagation();
      fn(el, ev);
    });
  }

  act("wing", (el) => { closeDrawer(); openWing(el.dataset.key); });
  act("guide", () => openManual(0));
  act("manual", () => openManual(0));
  act("manual-close", () => closeManual());
  act("manual-step", (el) => { state.manualStep = Number(el.dataset.step) || 0; renderManual(); });
  act("manual-next", () => manualMove(1));
  act("manual-prev", () => manualMove(-1));
  act("manual-copy", () => copyText(MANUAL_COMMAND, tr("manual.copied")));
  act("port-select", (el) => portSelect(el.dataset.kind, el.dataset.key));
  act("port-clear", () => { state.port.selected = null; renderPort(); });
  act("port-zoom-in", () => portZoom(1.18));
  act("port-zoom-out", () => portZoom(.85));
  act("port-reset", () => portResetCamera());
  act("focus-flow", (el) => {
    state.focus = el.dataset.key;
    closeDrawer();
    openWing("fluxo");
  });
  act("settings", () => openSettingsDrawer());
  act("settings-close", () => closeDrawer());
  act("alerts-save", () => saveAlerts());
  act("budget", () => openBudgetDrawer());
  act("budget-save", () => saveBudgets());
  act("budget-threshold", (el) => {
    state.budgets = normalizeBudgets({ ...state.budgets, threshold: Number(el.dataset.v) });
    store.set("budgets", state.budgets);
    renderBudgetBody();
    if (state.snap) { renderCockpit(); renderBand(); }
    persistBudgets().catch((err) => toast(tr("budget.saveFailed", { err: err.message }), "bad"));
  });
  act("budget-reset", () => {
    state.budgets = normalizeBudgets({});
    store.set("budgets", state.budgets);
    renderBudgetBody();
    if (state.snap) { renderCockpit(); renderBand(); }
    persistBudgets()
      .then(() => toast(tr("budget.saved")))
      .catch((err) => toast(tr("budget.saveFailed", { err: err.message }), "bad"));
  });
  act("sec-refresh", () => { state.security = null; loadSecurity(); });
  act("sec-copy", (el) => copyText(el.dataset.fix, tr("security.copied")));
  act("set-lang", (el) => {
    if (el.dataset.lang === state.lang) return;
    state.lang = el.dataset.lang;
    applyPrefs();
  });
  act("set-currency", (el) => {
    if (el.dataset.currency === state.currency) return;
    state.currency = el.dataset.currency;
    applyPrefs();
  });
  act("refresh", () => refreshData());
  act("light", () => toggleLight());
  act("palette", () => openPalette());
  act("tour", () => openManual(0));
  act("day", (el) => selectDay(el.dataset.date));
  act("day-reset", () => selectDay(state.snap.today.date));
  act("provider", (el) => toggleProvider(el.dataset.key));
  act("provider-detail", (el) => openProviderDrawer(el.dataset.key));
  act("focus-only", (el) => {
    state.focus = el.dataset.key;
    renderFleet();
    renderChart();
    closeDrawer();
    closeWing();
    toast(`Atlas filtrado por ${provName(el.dataset.key)}`);
  });
  act("focus-clear", () => { state.focus = ""; renderFleet(); renderChart(); closeDrawer(); toast("Filtro removido"); });
  act("quota", (el) => openQuotaDrawer(el.dataset.key));
  act("bucket", (el) => openBucketDrawer(Number(el.dataset.i)));
  act("error-detail", (el) => { markReviewed(Number(el.dataset.i)); openErrorDrawer(Number(el.dataset.i)); });
  act("error-copy", (el) => copyErrorPrompt(Number(el.dataset.i)));
  act("session", (el) => openSessionDrawer(el.dataset.id));
  act("project", (el) => openProjectDrawer(el.dataset.key));
  act("radar", (el) => openRadar(Number(el.dataset.i)));
  act("ask", (el) => { openWing("oraculo"); setTimeout(() => sendChat(el.dataset.q), 320); });
  act("copy-context", () => copyText(buildContextPrompt(), "Contexto da operação copiado"));
  act("copy-diag", () => copyText(buildDiagnosticPrompt(), "Diagnóstico completo copiado"));
  act("copy-report", () => copyText(buildReport(), "Relatório em Markdown copiado"));
  act("copy-error", (el) => copyErrorPrompt(Number(el.dataset.i)));
  act("export-json", () => exportJson());
  act("export-csv", () => exportCsv());
  act("export-month", () => exportMonthCsv());
  act("open-url", (el) => {
    const url = String(el.dataset.url || "");
    if (!/^https?:\/\//i.test(url)) { toast("Link indisponível neste snapshot", "warn"); return; }
    window.open(url, "_blank", "noopener");
  });
  act("palette-run", (el) => {
    const entry = state.palette[Number(el.dataset.i)];
    closePalette();
    if (entry?.run) setTimeout(entry.run, 60);
  });
  act("vote", (el) => vote(el.dataset.key));
  act("clear-chat", () => { state.chat = []; if (state.wing === "oraculo") renderWing("oraculo"); });
  act("chat-quick", (el) => sendChat(el.dataset.q));
  act("sim-days", (el) => setProjection(Number(el.dataset.days)));
  act("toggle-drawer", (el) => { const k = el.dataset.key; state.focus = k; renderFleet(); renderChart(); });
  act("help-error", (el) => openErrorDrawer(Number(el.dataset.i)));
  act("probe", (el) => runProbe(el.dataset.key));
  act("probe-all", () => runProbeAll());
  act("fleet-refresh", () => refreshFleet());

  function toggleProvider(key) {
    if (state.focus === key) {
      state.focus = "";
      renderFleet();
      renderChart();
      closeDrawer();
      toast("Filtro removido");
      return;
    }
    state.focus = key;
    renderFleet();
    renderChart();
    openProviderDrawer(key);
  }

  /* ---------------------------------------------------------- chrome bindings */

  function bindChrome() {
    $("#brandBtn").addEventListener("click", () => {
      closePalette(); closeDrawer(); closeWing();
    });
    $("#refreshBtn").addEventListener("click", refreshData);
    $("#searchBtn").addEventListener("click", openPalette);
    $("#lightToggle").addEventListener("click", toggleLight);
    $("#streak").addEventListener("click", () => openWing("diario"));
    $("#avatarBtn").addEventListener("click", () => openWing("perfil"));
    $("#localeBtn").addEventListener("click", openSettingsDrawer);
    $("#guideBtn").addEventListener("click", () => openManual(0));
    $("#startChip").addEventListener("click", () => openManual(0));
    document.querySelectorAll(".port-zoom button").forEach((b) => b.addEventListener("click", () => { const a = b.dataset.act; if (a === "port-zoom-in") portZoom(1.18); else if (a === "port-zoom-out") portZoom(.85); else portResetCamera(); }));
    $("#livePill").addEventListener("click", () => openWing("perfil"));
    $("#chipProviders").addEventListener("click", () => openWing("fluxo"));
    $("#chipXp").addEventListener("click", () => openWing("diario"));
    $("#chipLive").addEventListener("click", refreshData);
    $("#timeChip").addEventListener("click", () => selectDay(state.snap.today.date));
    $("#chipXp").title = "Abrir Diário e conquistas";
    $("#sunGauge").addEventListener("click", () => nextSun(true));
    $("#sunGauge").addEventListener("dblclick", () => {
      const s = state.sunStates[state.sunIndex];
      if (s) openQuotaDrawer(s.key);
    });
    $("#sunGauge").addEventListener("mouseenter", () => { state.sunPaused = true; });
    $("#sunGauge").addEventListener("mouseleave", () => { state.sunPaused = false; });
    $("#sunGauge").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); nextSun(true); }
    });
    $$(".seg button", $("#chartSeg")).forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("#chartExpand").addEventListener("click", () => openWing("fluxo"));
    $("#liveMore").addEventListener("click", () => openWing("sessoes"));
    $$(".tabs .tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $$(".rail-btn[data-wing]").forEach((b) => b.addEventListener("click", () => openWing(b.dataset.wing)));
    $("#railXp").addEventListener("click", () => openWing("diario"));
    $("#wingClose").addEventListener("click", closeWing);
    $("#wingBack").addEventListener("click", closeWing);
    $("#wingBackdrop").addEventListener("click", closeWing);
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerScrim").addEventListener("click", closeDrawer);
    $("#paletteScrim").addEventListener("click", closePalette);
    $("#paletteInput").addEventListener("input", (e) => renderPalette(e.target.value));
    $("#paletteInput").addEventListener("keydown", paletteKeys);
    $("#tourSkip").addEventListener("click", () => endTour(true));
    $("#tourNext").addEventListener("click", advanceTour);
    $("#pipCompanion").addEventListener("click", () => openWing("oraculo"));
    $("#pipCompanion").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWing("oraculo"); } });
    window.addEventListener("resize", scaleStage);
    const savedLight = store.get("light", "day");
    if (savedLight === "dusk") {
      app.dataset.light = "dusk";
      $("#lightLabel").textContent = tr("topbar.dusk");
    }
  }

  /* ---------------------------------------------------------- keyboard */

  function bindKeyboard() {
    document.addEventListener("keydown", (ev) => {
      const typing = /^(input|textarea|select)$/i.test(ev.target.tagName) || ev.target.isContentEditable;
      const manualOpen = !$("#manual").hidden && $("#manual").classList.contains("open");
      if (manualOpen && ev.key !== "Tab" && ev.key !== "Escape") return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        if ($("#palette").hidden) openPalette(); else closePalette();
        return;
      }
      if (ev.key === "Tab" && manualOpen) {
        const sheet = $("#manual .manual-sheet");
        const items = [...sheet.querySelectorAll("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
          .filter((el) => el.offsetParent !== null);
        if (items.length) {
          const first = items[0];
          const last = items[items.length - 1];
          if (!sheet.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
          else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      }
      if (ev.key === "Escape") {
        if (!$("#manual").hidden && $("#manual").classList.contains("open")) closeManual();
        else if (!$("#tour").hidden) endTour(true);
        else if (!$("#palette").hidden) closePalette();
        else if (!$("#drawer").hidden) closeDrawer();
        else if (state.wing) closeWing();
        return;
      }
      if (typing) return;
      if (ev.key === "?") { ev.preventDefault(); openManual(0); return; }
      if (ev.key.toLowerCase() === "r") { ev.preventDefault(); refreshData(); return; }
      if (ev.key.toLowerCase() === "d") { ev.preventDefault(); toggleLight(); return; }
      if (ev.key === "/") { ev.preventDefault(); openPalette(); return; }
      if (/^[1-9]$/.test(ev.key)) { openWing(WING_ORDER[Number(ev.key) - 1]); return; }
      if (ev.key === "0") { openWing("ajuda"); }
    });
  }

  /* ---------------------------------------------------------- wings shell */

  function openWing(key) {
    if (!WINGS[key]) return;
    if (key === "atlas") { closeWing(); return; }
    if (!state.snap) { toast("Os dados ainda estão carregando", "warn"); return; }
    closePalette();
    state.wing = key;
    state.visited.add(key);
    store.set("visited", [...state.visited]);
    const meta = WINGS[key];
    $("#wingIcon").innerHTML = railIcon(key);
    $("#wingEyebrow").textContent = meta.eyebrow;
    $("#wingTitle").textContent = tr(`nav.${key}`);
    $("#wingSub").textContent = tr(`wings.${key}.sub`);
    $("#crumbNow").textContent = tr(`nav.${key}`);
    $("#brandChip").textContent = key;
    $$(".rail-btn[data-wing]").forEach((b) => b.classList.toggle("active", b.dataset.wing === key));
    $("#wing").hidden = false;
    void $("#wing").offsetWidth;
    $("#wing").classList.add("open");
    renderWing(key);
    $("#wingBody").scrollTop = 0;
    renderQuests();
  }

  function closeWing() {
    if (!state.wing) return;
    const overlay = $("#wing");
    overlay.classList.remove("open");
    state.wing = null;
    setTimeout(() => { if (!state.wing) overlay.hidden = true; }, 320);
    $("#crumbNow").textContent = tr("nav.atlas");
    $("#brandChip").textContent = "atlas";
    $$(".rail-btn[data-wing]").forEach((b) => b.classList.toggle("active", b.dataset.wing === "atlas"));
  }

  function renderWing(key, opts = {}) {
    const renderer = WING_RENDERERS[key];
    if (!renderer) return;
    const scroll = opts.preserve ? $("#wingBody").scrollTop : 0;
    $("#wingBody").innerHTML = `<div class="w-loading">Montando ${esc(tr(`nav.${key}`))}…</div>`;
    $("#wingActions").innerHTML = wingActions(key);
    const html = renderer();
    $("#wingBody").innerHTML = html;
    bindWing(key);
    if (opts.preserve) $("#wingBody").scrollTop = scroll;
    renderQuests();
  }

  function wingActions(key) {
    const S = state.snap;
    const actions = {
      fluxo: `<button class="btn ghost" data-act="copy-report">Copiar relatório</button><button class="btn primary" data-act="open-url" data-url="${esc(S.router.links?.find((l) => l.label === "Abrir 9router")?.url || "")}">Abrir 9router</button>`,
      sessoes: `<button class="btn ghost" data-act="copy-context">Copiar contexto</button>`,
      oficina: `<button class="btn ghost" data-act="ask" data-q="Como reduzir o desperdício de leituras repetidas e skills?">Pedir plano</button>`,
      oraculo: `<button class="btn ghost" data-act="copy-context">Copiar contexto</button><button class="btn primary" data-act="copy-diag">Diagnóstico</button>`,
      biblioteca: `<button class="btn ghost" data-act="ask" data-q="Qual IA devo usar para cada tipo de tarefa?">Perguntar ao Oráculo</button>`,
      diario: `<button class="btn ghost" data-act="copy-report">Copiar changelog</button>`,
      guilda: `<button class="btn ghost" data-act="copy-report">Copiar release</button>`,
      perfil: `<button class="btn ghost" data-act="copy-diag">Diagnóstico</button><button class="btn primary" data-act="export-json">Exportar JSON</button>`,
      ajuda: `<button class="btn primary" data-act="copy-diag">Copiar diagnóstico</button>`,
    };
    return actions[key] || "";
  }

  /* ---------------------------------------------------------- drawers */

  function openDrawer(html) {
    state.settingsOpen = false;
    state.budgetOpen = false;
    state.drawerKey = "";
    $("#drawerBody").innerHTML = html;
    $("#drawer").hidden = false;
    $("#drawer").setAttribute("aria-hidden", "false");
    void $("#drawer").offsetWidth;
    $("#drawer").classList.add("open");
  }

  function closeDrawer() {
    const d = $("#drawer");
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    state.settingsOpen = false;
    state.budgetOpen = false;
    setTimeout(() => { if (!d.classList.contains("open")) d.hidden = true; }, 300);
  }

  /* ---------------------------------------------------------- language + currency */

  function applyShellTranslations() {
    document.documentElement.lang = locale();
    $$("[data-i18n]").forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    $$(".rail-btn[data-wing]").forEach((b) => {
      const key = b.dataset.wing;
      const label = tr(`nav.${key}`);
      b.dataset.label = label;
      b.title = `${label} · ${tr(`wings.${key}.sub`)}`;
      let lab = b.querySelector(".rail-label");
      if (!lab) { lab = document.createElement("small"); lab.className = "rail-label"; b.appendChild(lab); }
      lab.textContent = label;
    });
    $$(".tabs .tab").forEach((b) => {
      const names = { agora: "now", provedores: "providers", erros: "errors", dicas: "tips" };
      b.textContent = tr(`cockpit.${names[b.dataset.tab] || b.dataset.tab}`);
    });
    const dusk = app.dataset.light === "dusk";
    $("#lightLabel").textContent = tr(dusk ? "topbar.dusk" : "topbar.day");
    $("#localeLabel").textContent = `${state.lang.toUpperCase()} · ${CURRENCIES[state.currency]}`;
    $("#localeBtn").title = tr("topbar.locale");
    $("#guideBtn").title = tr("topbar.guide");
    const searchSpan = $("#searchBtn span");
    if (searchSpan) searchSpan.textContent = tr("topbar.search");
    $("#streak").title = `${state.snap ? int(state.snap.totals.activeDays) : ""} · ${tr("common.days")}`;
    const lvlBadge = $("#lvlBadge");
    if (lvlBadge && state.snap) {
      const lv = levelFor(xpTotals().xp);
      lvlBadge.textContent = lv.level;
    }
    if (state.wing) {
      $("#wingTitle").textContent = tr(`nav.${state.wing}`);
      $("#wingSub").textContent = tr(`wings.${state.wing}.sub`);
      $("#crumbNow").textContent = tr(`nav.${state.wing}`);
    } else {
      $("#crumbNow").textContent = tr("nav.atlas");
    }
  }

  function applyPrefs() {
    store.set("lang", state.lang);
    store.set("currency", state.currency);
    store.set("rates", state.rates);
    applyShellTranslations();
    if (state.snap) applySnapshot(state.snap);
    if (state.settingsOpen) renderSettingsBody();
    if (state.budgetOpen) renderBudgetBody();
    toast(tr("settings.saved"));
  }

  function openSettingsDrawer() {
    state.settingsOpen = true;
    state.budgetOpen = false;
    renderSettingsBody();
    $("#drawer").hidden = false;
    $("#drawer").setAttribute("aria-hidden", "false");
    void $("#drawer").offsetWidth;
    $("#drawer").classList.add("open");
  }

  function renderSettingsBody() {
    const languages = (I18N?.languages || []).map((l) => `
      <button class="set-opt${l.code === state.lang ? " on" : ""}" data-act="set-lang" data-lang="${l.code}">
        <b>${esc(l.label)}</b><span>${esc(l.region)}</span>
      </button>`).join("");
    const currencies = [
      ["BRL", tr("settings.brl"), "R$"],
      ["USD", tr("settings.usd"), "$"],
      ["EUR", tr("settings.eur"), "€"],
    ].map(([code, label, symbol]) => `
      <button class="set-opt${code === state.currency ? " on" : ""}" data-act="set-currency" data-currency="${code}">
        <b>${symbol} · ${esc(code)}</b><span>${esc(label)}</span>
      </button>`).join("");
    const rates = ["USD", "EUR"].map((code) => `
      <label class="set-rate">
        <span>1 ${code} =</span>
        <input type="number" name="rate-${code}" step="0.01" min="0.01" value="${Number(state.rates[code] || 0).toFixed(2)}" data-rate="${code}" aria-label="1 ${code} em BRL">
        <em>BRL</em>
      </label>`).join("");
    const langLabel = (I18N?.languages || []).find((l) => l.code === state.lang)?.label || state.lang;
    const alertsCfg = state.snap?.settings?.alerts || { macos: true, cooldown_min: 360, webhook_set: false, webhook_host: "" };
    const cooldowns = [60, 180, 360, 720, 1440].map((v) =>
      `<option value="${v}"${v === alertsCfg.cooldown_min ? " selected" : ""}>${esc(tr("settings.cooldown", { h: v / 60 }))}</option>`).join("");
    $("#drawerBody").innerHTML = `
      <span class="drw-eyebrow">${esc(tr("settings.eyebrow"))}</span>
      <div class="drw-head">
        <span class="drw-mark" style="--pc:#4a8bf5">A</span>
        <div><h2>${esc(tr("settings.title"))}</h2><p>${esc(tr("settings.currencySub"))}</p></div>
      </div>
      <div class="drw-section"><h3>${esc(tr("settings.language"))}</h3><div class="set-grid">${languages}</div><div class="drw-note">${esc(tr("settings.languageSub"))}</div></div>
      <div class="drw-section"><h3>${esc(tr("settings.currency"))}</h3><div class="set-grid">${currencies}</div></div>
      <div class="drw-section"><h3>${esc(tr("settings.rates"))}</h3><div class="set-rates">${rates}</div><div class="drw-note">${esc(tr("settings.ratesNote"))}</div></div>
      <div class="drw-section"><h3>${esc(tr("settings.alerts"))}</h3>
        <div class="set-alert">
          <label class="set-check"><input type="checkbox" data-alert="macos"${alertsCfg.macos ? " checked" : ""}><span><b>${esc(tr("settings.alertsMacos"))}</b><em>${esc(tr("settings.alertsMacosSub"))}</em></span></label>
          <label class="set-field"><span>${esc(tr("settings.alertsWebhook"))}</span>
            <input type="password" data-alert="webhook" autocomplete="off" spellcheck="false" placeholder="${esc(alertsCfg.webhook_set ? tr("settings.alertsWebhookSet", { host: alertsCfg.webhook_host }) : "https://")}">
          </label>
          ${alertsCfg.webhook_set ? `<label class="set-check"><input type="checkbox" data-alert="webhook-clear"><span><b>${esc(tr("settings.alertsWebhookClear"))}</b></span></label>` : ""}
          <label class="set-field"><span>${esc(tr("settings.alertsCooldown"))}</span><select data-alert="cooldown">${cooldowns}</select></label>
        </div>
        <div class="drw-note">${esc(tr("settings.alertsNote"))}</div>
        <div class="set-alert-actions"><button class="btn primary" data-act="alerts-save">${esc(tr("settings.alertsSave"))}</button></div>
      </div>
      <div class="drw-note">${esc(tr("settings.beta", { lang: langLabel }))}</div>
      <div class="drw-actions"><button class="btn primary" data-act="settings-close">${esc(tr("common.done"))}</button></div>
    `;
    $$("#drawerBody [data-rate]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const code = inp.dataset.rate;
        const value = Number(String(inp.value).replace(",", "."));
        if (value > 0) {
          state.rates[code] = value;
          store.set("rates", state.rates);
          if (state.snap) applySnapshot(state.snap);
        }
      });
    });
  }

  function saveAlerts() {
    const alerts = {};
    const macos = $("#drawerBody [data-alert='macos']");
    if (macos) alerts.macos = macos.checked;
    const webhook = $("#drawerBody [data-alert='webhook']");
    if (webhook && webhook.value.trim()) alerts.webhook = webhook.value.trim();
    const clear = $("#drawerBody [data-alert='webhook-clear']");
    if (clear && clear.checked) alerts.webhook_clear = true;
    const cooldown = $("#drawerBody [data-alert='cooldown']");
    if (cooldown) alerts.cooldown_min = Number(cooldown.value);
    pushSettings({ alerts })
      .then((data) => {
        if (state.snap && data?.alerts) {
          state.snap.settings = {
            budgets: data.budgets,
            alerts: data.alerts,
            updated_at: data.updated_at,
          };
        }
        renderSettingsBody();
        toast(tr("settings.saved"));
      })
      .catch((err) => toast(tr("budget.saveFailed", { err: err.message }), "bad"));
  }

  function recommendedActions() {
    const S = state.snap;
    const u = monthUsage();
    const errors = (S.errors || []).length;
    const cache = Number(S.totals?.cacheHit || 0);
    const free = S.quota?.codex?.available ? Number(S.quota.codex.week_free || 0) : null;
    const list = [];

    const globalState = u && state.budgets.global ? budgetStatus(u.cost, state.budgets.global) : null;
    const providerStates = u ? Object.entries(state.budgets.providers)
      .map(([key, limit]) => ({ label: provName(key), st: budgetStatus(u.byProvider[key] || 0, limit) }))
      .filter((x) => x.st)
      .sort((a, b) => b.st.pct - a.st.pct) : [];
    const worstGlobal = globalState ? { label: tr("budget.total"), st: globalState } : null;
    const worst = !worstGlobal ? providerStates[0]
      : !providerStates[0] || worstGlobal.st.pct >= providerStates[0].st.pct ? worstGlobal : providerStates[0];

    if (worst?.st.tone === "over") {
      list.push({ pri: 130, act: "budget", label: tr("action.budgetOver", { pct: pct(worst.st.pct, 0) }), detail: tr("action.budgetOverSub", { v: money(Math.max(0, -worst.st.left)) }) });
    } else if (worst?.st.tone === "warn") {
      list.push({ pri: 120, act: "budget", label: tr("action.budgetNear", { pct: pct(worst.st.pct, 0) }), detail: tr("action.budgetNearSub", { v: money(Math.max(0, worst.st.left)) }) });
    }
    if (errors) list.push({ pri: 110, wing: "ajuda", label: tr("action.reviewErrors", { n: errors }), detail: tr("action.reviewErrorsSub") });
    if (free != null && free < 35) list.push({ pri: 100, wing: "fluxo", label: tr("action.quotaLow", { pct: pct(free, 0) }), detail: tr("action.quotaLowSub") });
    if (cache < 65) list.push({ pri: 60, wing: "fluxo", label: tr("action.cacheLow"), detail: tr("action.cacheLowSub", { pct: pct(cache) }) });
    if (!state.budgets.global && !Object.keys(state.budgets.providers).length) {
      list.push({ pri: 50, act: "budget", label: tr("action.budget"), detail: tr("action.budgetSub") });
    }
    if (S.qoder?.sessions?.length) list.push({ pri: 10, wing: "sessoes", label: tr("action.explore"), detail: tr("action.exploreSub", { n: int(S.qoder.sessions.length) }) });
    return list.sort((a, b) => b.pri - a.pri).slice(0, 2).map(({ pri, ...rest }) => rest);
  }

  function budgetStrip() {
    const u = monthUsage();
    if (!u) return "";
    const b = state.budgets;
    const hasBudget = Boolean(b.global || Object.keys(b.providers).length);
    if (!hasBudget) {
      return `<button class="budget-strip empty" data-act="budget">
        <span class="bs-ico">◎</span>
        <span class="bs-main">
          <span class="bs-top"><b>${esc(tr("cockpit.budgetTitle"))}</b><em>${esc(tr("budget.month"))}</em></span>
          <span class="bs-sub">${esc(tr("cockpit.budgetEmpty"))}</span>
        </span>
        <em>${esc(tr("budget.configure"))}</em>
      </button>`;
    }
    const st = b.global ? budgetStatus(u.cost, b.global) : null;
    const tone = st?.tone || "ok";
    const fill = st ? clamp(st.pct) : clamp((u.cost / Math.max(1, u.projected)) * 100);
    return `<button class="budget-strip ${tone}" data-act="budget">
      <span class="bs-ico">◎</span>
      <span class="bs-main">
        <span class="bs-top"><b>${esc(tr("cockpit.budgetTitle"))}</b><em>${st ? pct(st.pct, 0) : esc(money(u.cost))}</em></span>
        <span class="bs-bar"><i style="width:${fill}%"></i>${st ? `<span class="bs-mark" style="left:${b.threshold}%"></span>` : ""}</span>
        <span class="bs-sub">${st ? `${esc(money(u.cost))} / ${esc(money(b.global))} · ${esc(tr("budget.forecast", { v: money(u.projected) }))}` : esc(tr("budget.provider"))} · ${esc(tr("budget.dayOfMonth", { d: u.elapsed, n: u.daysInMonth }))}</span>
      </span>
      <em>${esc(tr("budget.edit"))}</em>
    </button>`;
  }

  function budgetWingCard() {
    const u = monthUsage();
    if (!u) return "";
    const b = state.budgets;
    if (!b.global && !Object.keys(b.providers).length) {
      return `<div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>${esc(tr("budget.title"))}</h3><p>${esc(tr("budget.sub"))}</p></div><span class="pill warn">${esc(tr("budget.noLimit"))}</span></div>
        <div class="w-bud-empty"><b>${esc(tr("cockpit.budgetEmpty"))}</b><button class="btn primary" data-act="budget">${esc(tr("budget.configure"))}</button></div>
      </div>`;
    }
    const st = b.global ? budgetStatus(u.cost, b.global) : null;
    const tone = st?.tone || "ok";
    const rows = Object.entries(b.providers).map(([key, limit]) => {
      const ps = budgetStatus(u.byProvider[key] || 0, limit);
      return `<div class="w-bud-row">
        <span class="w-bud-name"><i style="background:${provColor(key)}"></i>${esc(provName(key))}</span>
        <span class="w-bud-track ${ps.tone}"><i style="width:${clamp(ps.pct)}%"></i></span>
        <span class="w-bud-val">${pct(ps.pct, 0)}</span>
      </div>`;
    }).join("");
    return `<div class="w-card" style="margin-top:12px">
      <div class="w-card-head"><div><h3>${esc(tr("budget.title"))}</h3><p>${esc(tr("budget.globalSub", { d: u.elapsed, n: u.daysInMonth }))}</p></div><span class="pill ${tone === "over" ? "warn" : tone === "warn" ? "warn" : ""}">${st ? pct(st.pct, 0) : esc(tr("budget.provider"))}</span></div>
      <div class="w-bud">
        <div class="w-bud-top"><b>${money(u.cost)}</b><span>${b.global ? `/ ${money(b.global)}` : esc(tr("budget.provider"))}</span><em>${esc(tr("budget.forecast", { v: money(u.projected) }))}</em></div>
        ${st ? `<span class="bud-bar ${tone}"><i style="width:${clamp(st.pct)}%"></i><span class="bud-bar-mark" style="left:${b.threshold}%"></span></span>` : ""}
        ${rows ? `<div class="w-bud-rows">${rows}</div>` : ""}
      </div>
      <div class="w-bud-actions"><button class="btn ghost" data-act="budget">${esc(tr("budget.edit"))}</button></div>
    </div>`;
  }

  function healthCard() {
    const slo = state.snap?.slo;
    const rows = (slo?.providers || []).filter((p) => p.requests);
    if (!rows.length) return "";
    const overall = slo.overall || {};
    const dot = (tone) => tone === "bad" ? "#c15546" : tone === "warn" ? "#e6a62d" : "#2f9e6b";
    return `<div class="w-card" style="margin-top:12px">
      <div class="w-card-head"><div><h3>${esc(tr("health.title"))}</h3><p>${esc(tr("health.sub"))}</p></div><span class="pill">${esc(tr(`health.${overall.tone || "ok"}`))}</span></div>
      <div class="w-table health-table">
        <div class="w-row head" style="grid-template-columns:minmax(0,1fr) 64px 64px 64px 56px 66px">
          <span>${esc(tr("health.provider"))}</span><span>${esc(tr("health.calls"))}</span><span>${esc(tr("health.p50"))}</span><span>${esc(tr("health.p95"))}</span><span>${esc(tr("health.errorRate"))}</span><span>${esc(tr("health.ttft"))}</span>
        </div>
        ${rows.map((p) => `<div class="w-row" style="grid-template-columns:minmax(0,1fr) 64px 64px 64px 56px 66px">
          <span class="r-main"><b>${esc(provName(p.provider))}</b><span><i class="health-dot" style="background:${dot(p.tone)}"></i>${esc(tr(`health.${p.tone}`))}</span></span>
          <span class="num">${int(p.requests)}</span>
          <span class="num">${latency(p.p50)}</span>
          <span class="num">${latency(p.p95)}</span>
          <span class="num" style="color:${p.errorRate >= 5 ? "var(--signal-ink)" : p.errorRate > 0 ? "#8A5C0F" : "#1D6F52"}">${pct(p.errorRate, 0)}</span>
          <span class="num">${latency(p.ttftP50)}</span>
        </div>`).join("")}
      </div>
      <div class="w-health-foot">
        <span>${esc(tr("health.method", { window: esc(tr("health.window7d")) }))}</span>
        <span class="w-health-actions">
          <button class="btn ghost" data-act="export-month">${esc(tr("fluxo.exportMonth"))}</button>
          <button class="btn ghost" data-act="export-csv">${esc(tr("fluxo.exportCsv"))}</button>
          <button class="btn ghost" data-act="open-url" data-url="${esc(`${location.origin}/metrics`)}">${esc(tr("health.metrics"))}</button>
        </span>
      </div>
    </div>`;
  }

  function exportCsv() {
    const S = state.snap;
    if (!S) return;
    const providers = (S.providers || []).map((p) => p.provider);
    const head = ["date", "requests", "tokens", "input", "cached", "cost_usd",
      ...providers.flatMap((p) => [`${p}_tokens`, `${p}_requests`, `${p}_cost_usd`])];
    const lines = [head.join(",")];
    (S.series || []).forEach((d) => {
      lines.push([
        d.date, d.requests, d.tokens, d.input, d.cached, Number(d.cost || 0).toFixed(4),
        ...providers.flatMap((p) => [
          d.providers?.[p]?.tokens || 0,
          d.providers?.[p]?.requests || 0,
          Number(d.providers?.[p]?.cost || 0).toFixed(4),
        ]),
      ].join(","));
    });
    lines.push("");
    lines.push("provider,requests,tokens,cost_usd,p50_ms,p95_ms,ttft_p50_ms,error_rate_pct");
    (S.providers || []).forEach((p) => {
      const slo = (S.slo?.providers || []).find((x) => x.provider === p.provider) || {};
      lines.push([p.provider, p.requests, p.tokens, Number(p.cost || 0).toFixed(4), slo.p50 || "", slo.p95 || "", slo.ttftP50 || "", slo.errorRate ?? ""].join(","));
    });
    const blob = new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rune-usage-${S.today?.date || new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(tr("fluxo.csvSaved"));
  }

  function exportMonthCsv() {
    const month = state.snap?.month?.month || new Date().toISOString().slice(0, 7);
    const a = document.createElement("a");
    a.href = `/api/export.csv?month=${encodeURIComponent(month)}`;
    a.download = `rune-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(tr("fluxo.exportMonthSaved", { month }));
  }

  async function loadSecurity() {
    if (state.securityLoading) return;
    state.securityLoading = true;
    renderSecurityBox();
    try {
      const res = await fetch("/api/security", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.security = await res.json();
    } catch (err) {
      state.security = { error: err.message, findings: [], checks: [] };
    } finally {
      state.securityLoading = false;
      renderSecurityBox();
    }
  }

  function renderSecurityBox() {
    const box = $("#secBox");
    if (box) box.innerHTML = securityBody();
  }

  function securityBody() {
    const sec = state.security;
    if (!sec || state.securityLoading) {
      return `<div class="w-card-head"><div><h3>${esc(tr("security.title"))}</h3><p>${esc(tr("security.sub"))}</p></div><span class="pill">${esc(tr("security.checking"))}</span></div>
        <div class="sec-loading"><i></i><span>${esc(tr("security.loadingSub"))}</span></div>`;
    }
    if (sec.error) {
      return `<div class="w-card-head"><div><h3>${esc(tr("security.title"))}</h3><p>${esc(tr("security.sub"))}</p></div><span class="pill warn">offline</span></div>
        <div class="sec-empty">${esc(tr("security.error"))} · ${esc(sec.error)}</div>
        <div class="drw-actions" style="margin-top:10px"><button class="btn ghost" data-act="sec-refresh">${esc(tr("security.rescan"))}</button></div>`;
    }
    const findings = sec.findings || [];
    const checks = sec.checks || [];
    const level = sec.level || "ok";
    const passed = checks.filter((c) => c.ok).length;
    const when = sec.checked_at ? new Date(sec.checked_at).toLocaleTimeString(state.lang, { hour: "2-digit", minute: "2-digit" }) : "—";
    const secKey = (key, vars, fallback) => { const text = tr(key, vars); return text === key ? fallback : text; };
    const findingTitle = (f) => f.code === "perm"
      ? secKey("security.f.perm", { target: secKey(`security.target.${f.params?.target}`, null, f.params?.target || "") }, f.title)
      : secKey(`security.f.${f.code}`, f.params, f.title);
    const findingDetail = (f) => f.code === "perm"
      ? secKey("security.f.permDetail", f.params, f.detail)
      : secKey(`security.f.detail.${f.code}`, f.params, f.detail);
    const checkLabel = (c) => secKey(`security.c.${c.key}`, null, c.label);
    const checkDetail = (c) => {
      if (c.key === "bind") return secKey("security.c.bindDetail", c.params, c.detail);
      if (c.key === "perms") {
        const modes = c.params?.modes;
        if (modes) return Object.entries(modes).map(([target, mode]) => `${secKey(`security.target.${target}`, null, target)} ${mode}`).join(" · ");
        return secKey("security.c.permsDetail", c.params, c.detail);
      }
      if (c.key === "secrets") return secKey(c.ok ? "security.c.secretsClean" : "security.c.secretsHits", c.params, c.detail);
      if (c.key === "tunnel") return secKey(`security.c.tunnelDetail.${c.params?.state || "off"}`, null, c.detail);
      return secKey(`security.c.detail.${c.key}`, null, c.detail);
    };
    return `<div class="w-card-head"><div><h3>${esc(tr("security.title"))}</h3><p>${esc(tr("security.sub"))}</p></div><span class="pill ${level === "ok" ? "ok" : level === "bad" ? "bad" : "warn"}">${esc(tr(`security.${level === "ok" ? "ok" : "findings"}`, { n: findings.length }))}</span></div>
      <div class="sec-top">
        <div class="sec-score ${level}"><b>${int(sec.score)}</b><span>/100</span><em>${esc(tr(`security.tone.${level}`))}</em></div>
        <div class="sec-summary">
          ${findings.length ? findings.map((f) => `<div class="sec-finding ${f.level}">
            <span class="sec-ico">${f.level === "bad" ? "!" : f.level === "warn" ? "▲" : "i"}</span>
            <div class="sec-main"><b>${esc(findingTitle(f))}</b><p>${esc(findingDetail(f))}</p></div>
            ${f.fix ? `<button class="btn ghost sec-fix" data-act="sec-copy" data-fix="${esc(f.fix)}">${esc(tr("security.copyFix"))}</button>` : ""}
          </div>`).join("") : `<div class="sec-empty ok">${esc(tr("security.ok"))}</div>`}
        </div>
      </div>
      <div class="sec-checks-head"><span>${esc(tr("security.checks"))}</span><em>${passed}/${checks.length} · ${esc(tr("security.checked"))} ${esc(when)}</em></div>
      <div class="sec-checks">
        ${checks.map((c) => `<div class="sec-check ${c.ok ? "ok" : "warn"}" title="${esc(checkDetail(c))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${c.ok ? "M5 13l4 4L19 7" : "M12 8v5m0 3.5v.5"}"/></svg><span>${esc(checkLabel(c))}</span><em>${esc(checkDetail(c))}</em></div>`).join("")}
      </div>
      <div class="sec-foot">
        <span>${esc(tr("security.foot"))}</span>
        <button class="btn ghost" data-act="sec-refresh">${esc(tr("security.rescan"))}</button>
      </div>`;
  }

  function openBudgetDrawer() {
    state.budgetOpen = true;
    renderBudgetBody();
    const d = $("#drawer");
    d.hidden = false;
    d.setAttribute("aria-hidden", "false");
    void d.offsetWidth;
    d.classList.add("open");
  }

  function renderBudgetBody() {
    const u = monthUsage();
    const b = state.budgets;
    const spent = u?.cost || 0;
    const st = b.global ? budgetStatus(spent, b.global) : null;
    const globalValue = b.global ? toDisplay(b.global).toFixed(2) : "";
    const keys = [...new Set([...(state.snap?.providers || []).map((p) => p.provider), ...Object.keys(b.providers)])];
    const rows = keys
      .sort((a, bKey) => (u?.byProvider[bKey] || 0) - (u?.byProvider[a] || 0))
      .map((key) => {
        const limit = b.providers[key];
        const ps = limit ? budgetStatus(u?.byProvider[key] || 0, limit) : null;
        return `<div class="bud-row">
          <div class="bud-row-top">
            <span class="bud-prov"><i style="background:${provColor(key)}"></i><b>${esc(provName(key))}</b><em>${money(u?.byProvider[key] || 0)}</em></span>
            <label class="bud-input"><span>${CURRENCIES[state.currency] || ""}</span><input type="number" name="budget-${esc(key)}" step="1" min="0" placeholder="${esc(tr("budget.placeholder"))}" data-budget="p:${esc(key)}" value="${limit ? toDisplay(limit).toFixed(2) : ""}" aria-label="${esc(tr("budget.provider"))} ${esc(provName(key))}"></label>
          </div>
          ${limit ? `<span class="bud-track ${ps.tone}"><i style="width:${clamp(ps.pct)}%"></i><span class="bud-track-mark" style="left:${b.threshold}%"></span></span>
          <span class="bud-row-sub">${esc(tr("budget.usedOf", { used: money(u?.byProvider[key] || 0), limit: money(limit), pct: dec(ps.pct, 0) }))}${ps.tone !== "ok" ? ` · ${esc(ps.tone === "over" ? tr("budget.over", { v: money(-ps.left) }) : tr("budget.remaining", { v: money(ps.left) }))}` : ""}</span>`
            : `<span class="bud-row-sub">${esc(tr("budget.noLimit"))}</span>`}
        </div>`;
      }).join("");
    const thresholdBtns = [50, 60, 70, 80, 90].map((v) => `<button class="bud-th${v === b.threshold ? " on" : ""}" data-act="budget-threshold" data-v="${v}">${v}%</button>`).join("");
    $("#drawerBody").innerHTML = `
      <span class="drw-eyebrow">${esc(tr("budget.eyebrow"))}</span>
      <div class="drw-head">
        <span class="drw-mark" style="--pc:#f4bd4a">◎</span>
        <div><h2>${esc(tr("budget.title"))}</h2><p>${esc(tr("budget.sub"))}</p></div>
      </div>
      <div class="bud-hero ${st?.tone || ""}">
        <div class="bud-hero-top"><span>${esc(tr("budget.total"))}</span><b>${money(spent)}</b><em>${b.global ? esc(`/ ${money(b.global)}`) : esc(tr("budget.noLimit"))}</em></div>
        ${b.global ? `<span class="bud-bar ${st.tone}"><i style="width:${clamp(st.pct)}%"></i><span class="bud-bar-mark" style="left:${b.threshold}%"></span></span>
        <div class="bud-hero-foot"><span>${esc(tr("budget.usedOf", { used: money(spent), limit: money(b.global), pct: dec(st.pct, 0) }))}</span><span>${esc(tr("budget.forecast", { v: money(u.projected) }))}</span></div>` : ""}
      </div>
      <div class="drw-section"><h3>${esc(tr("budget.global"))}</h3>
        <label class="bud-input wide"><span>${CURRENCIES[state.currency] || ""}</span><input type="number" name="budget-global" step="1" min="0" placeholder="${esc(tr("budget.placeholder"))}" data-budget="global" value="${globalValue}" aria-label="${esc(tr("budget.global"))}"><em>${esc(tr("budget.month"))}</em></label>
        <div class="drw-note">${esc(tr("budget.globalSub", { d: u.elapsed, n: u.daysInMonth }))}</div>
      </div>
      <div class="drw-section"><h3>${esc(tr("budget.threshold"))}</h3><div class="bud-threshold">${thresholdBtns}</div><div class="drw-note">${esc(tr("budget.thresholdSub"))}</div></div>
      <div class="drw-section"><h3>${esc(tr("budget.provider"))}</h3><div class="bud-rows">${rows}</div></div>
      <div class="drw-actions">
        <button class="btn primary" data-act="budget-save">${esc(tr("budget.save"))}</button>
        <button class="btn ghost" data-act="budget-reset">${esc(tr("budget.reset"))}</button>
      </div>
    `;
  }

  function persistBudgets() {
    return pushSettings({ budgets: state.budgets }).then((data) => {
      if (data?.budgets) {
        state.budgets = normalizeBudgets(data.budgets);
        store.set("budgets", state.budgets);
      }
      return data;
    });
  }

  function saveBudgets() {
    const providers = {};
    let global = null;
    $$("#drawerBody [data-budget]").forEach((inp) => {
      const value = Number(String(inp.value).replace(",", "."));
      const base = value > 0 ? Math.round(fromDisplay(value) * 100) / 100 : null;
      if (inp.dataset.budget === "global") global = base;
      else if (base) providers[inp.dataset.budget.slice(2)] = base;
    });
    state.budgets = normalizeBudgets({ ...state.budgets, global, providers });
    store.set("budgets", state.budgets);
    renderBudgetBody();
    if (state.snap) {
      renderCockpit();
      renderBand();
    }
    persistBudgets()
      .then(() => toast(tr("budget.saved")))
      .catch((err) => toast(tr("budget.saveFailed", { err: err.message }), "bad"));
  }

  function openProviderDrawer(key) {
    const S = state.snap;
    const meta = provMeta(key);
    const usage = (S.providers || []).find((p) => p.provider === key);
    const conn = (S.connections || []).find((c) => c.provider === key);
    const models = (S.models || []).filter((m) => m.provider === key).slice(0, 5);
    const quota = key === "codex" ? S.quota?.codex : key === "claude" ? S.quota?.claude : key === "google" ? S.quota?.google : null;
    const slo = (S.slo?.providers || []).find((x) => x.provider === key);
    const kb = knowledgeFor(key);
    const kpis = [
      ["tokens", usage ? compact(usage.tokens) : "0"],
      ["chamadas", usage ? int(usage.requests) : "0"],
      ["custo", usage ? money(usage.cost) : "—"],
      ["share", usage ? pct(usage.share) : "—"],
    ];
    openDrawer(`
      <span class="drw-eyebrow">${esc(meta.vendor || "provedor")} · manual local</span>
      <div class="drw-head">
        <span class="drw-mark" style="--pc:${meta.color}">${esc(meta.glyph)}</span>
        <div><h2>${esc(meta.name)}</h2><p>${esc(kb?.tag || "provedor conectado")} · ${conn ? (conn.status === "active" ? "conexão ativa" : `conexão com erro${conn.errorCode ? ` ${conn.errorCode}` : ""}`) : "sem conexão"}</p></div>
      </div>
      <div class="drw-kpis">${kpis.map(([k, v]) => `<div class="drw-kpi"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
      ${kb ? `<div class="drw-section"><h3>Para que serve</h3><div class="drw-note" style="margin-top:0">${esc(kb.purpose)}</div></div>
      <div class="drw-section"><h3>Melhor para</h3>${kb.best.map((x) => `<div class="drw-line manual"><span>✓</span><b>${esc(x)}</b></div>`).join("")}</div>
      <div class="drw-section"><h3>Evite quando</h3>${kb.avoid.map((x) => `<div class="drw-line manual bad"><span>×</span><b>${esc(x)}</b></div>`).join("")}</div>
      <div class="drw-section"><h3>Como administrar o consumo</h3>${kb.manage.map((x) => `<div class="drw-line manual"><span>•</span><b>${esc(x)}</b></div>`).join("")}</div>` : ""}
      ${quota && quota.available ? `<div class="drw-section"><h3>Cota agora</h3>
        ${quota.week_free != null ? `<div class="drw-line"><span>folga semanal</span><b>${pct(quota.week_free)}</b></div>` : ""}
        ${quota.session_free != null ? `<div class="drw-line"><span>folga da sessão</span><b>${pct(quota.session_free)}</b></div>` : ""}
        ${quota.week_reset ? `<div class="drw-line"><span>reset semanal</span><b>${esc(until(quota.week_reset))}</b></div>` : ""}
        ${quota.credit_free != null ? `<div class="drw-line"><span>crédito livre</span><b>${pct(quota.credit_free)}</b></div>` : ""}
        ${quota.pace != null ? `<div class="drw-line"><span>ritmo / meta</span><b>${pct(quota.pace)} / ${pct(quota.target)} ao dia</b></div>` : ""}
      </div>` : ""}
      ${slo ? `<div class="drw-section"><h3>${esc(tr("health.title"))}</h3>
        <div class="drw-line"><span>${esc(tr("health.calls"))}</span><b>${int(slo.requests)} · ${pct(slo.errorRate, 0)} ${esc(tr("health.errorRate"))}</b></div>
        <div class="drw-line"><span>p50</span><b>${latency(slo.p50)}</b></div>
        <div class="drw-line"><span>p95</span><b>${latency(slo.p95)}</b></div>
        <div class="drw-line"><span>${esc(tr("health.ttft"))}</span><b>${latency(slo.ttftP50)}</b></div>
        <div class="drw-line"><span>${esc(tr("health.metrics"))}</span><button class="btn ghost" style="padding:3px 8px" data-act="open-url" data-url="${esc(`${location.origin}/metrics`)}">/metrics</button></div>
      </div>` : ""}
      ${models.length ? `<div class="drw-section"><h3>Modelos no período</h3>${models.map((m) => `<div class="drw-line"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(modelName(m.model))}</span><b>${compact(m.tokens)} · ${money(m.cost)}</b></div>`).join("")}</div>` : ""}
      ${(() => {
        const f = fleetFor(key);
        const p = probeFor(key);
        if (!f && !p) return "";
        const caps = f ? [f.vision && tr("fleet.capVision"), f.tools && tr("fleet.capTools"), f.reasoning && tr("fleet.capReasoning"), f.free && tr("fleet.capFree")].filter(Boolean) : [];
        return `<div class="drw-section"><h3>${esc(tr("fleet.section"))}</h3>
          <div class="drw-line"><span>${esc(tr("fleet.routeIn"))}</span><b>${f ? `${int(f.models)} ${esc(tr("fleet.models"))}` : esc(tr("fleet.noRouteCatalog"))}</b></div>
          ${f?.context ? `<div class="drw-line"><span>${esc(tr("fleet.maxContext"))}</span><b>${compact(f.context)} tokens</b></div>` : ""}
          ${caps.length ? `<div class="drw-line"><span>${esc(tr("fleet.caps"))}</span><b>${esc(caps.join(" · "))}</b></div>` : ""}
          <div class="drw-line"><span>${esc(tr("fleet.lastTest"))}</span><b>${probeChip(key)}</b></div>
          ${p?.model ? `<div class="drw-line"><span>${esc(tr("fleet.testedModel"))}</span><b class="drw-mono">${esc(p.model)}</b></div>` : ""}
          ${p?.status === "fail" && p.error ? `<div class="drw-note bad" style="margin-top:8px">${esc(friendlyError(p.error))}</div>
            <details class="drw-details"><summary>${esc(tr("fleet.raw"))}</summary><div class="drw-line small"><b class="drw-mono" style="white-space:pre-wrap">${esc(p.error)}</b></div></details>` : ""}
          ${(p?.attempts || []).length > 1 ? `<details class="drw-details"><summary>${esc(tr("fleet.attempts", { n: p.attempts.length }))}</summary>${p.attempts.map((a) => `<div class="drw-line small"><span class="drw-mono">${esc(a.model || "")}</span><b>${a.ok ? `ok · ${int(a.ms || 0)} ms` : `${a.code || "erro"} · ${int(a.ms || 0)} ms`}</b></div>`).join("")}</details>` : ""}
          <div class="drw-actions" style="margin-top:8px">
            <button class="btn ghost" data-act="probe" data-key="${esc(key)}"${p?.status === "running" ? " disabled" : ""}>${esc(p?.status === "running" ? tr("fleet.testing") : tr("fleet.testOne"))}</button>
            <button class="btn ghost" data-act="fleet-refresh">${esc(tr("fleet.loadCatalog"))}</button>
          </div>
        </div>`;
      })()}
      ${kb ? `<div class="drw-section"><h3>Documentação oficial</h3><div class="drw-actions" style="margin-top:6px;flex-direction:column">${kb.docs.map(([label, url]) => `<button class="btn ghost" data-act="open-url" data-url="${esc(url)}" style="justify-content:flex-start">${esc(label)} ↗</button>`).join("")}</div></div>` : ""}
      <div class="drw-note">${esc(kb?.verdict || "Provedor conectado ao 9router.")}<br><br>Nenhuma chave ou token é exibido. A leitura é somente local.</div>
      <div class="drw-actions">
        <button class="btn ghost" data-act="focus-only" data-key="${esc(key)}">Filtrar no gráfico</button>
        <button class="btn primary" data-act="ask" data-q="${esc(`Qual a melhor forma de usar ${meta.name} e controlar o consumo?`)}">Perguntar ao Oráculo</button>
      </div>
    `);
    state.drawerKey = key;
  }

  function openQuotaDrawer(key) {
    const S = state.snap;
    const q = S.quota || {};
    let title = "Cota", provider = key.split("-")[0], lines = [], note = "";
    if (key.startsWith("codex") && q.codex?.available) {
      const c = q.codex;
      title = key.includes("session") ? "Codex · janela de 5h" : "Codex · semana";
      lines = [
        ["plano", c.plan || "—"],
        ["folga semanal", pct(c.week_free)],
        ["reset semanal", `${until(c.week_reset)} (${esc(c.week_reset)})`],
        ["folga da sessão", pct(c.session_free)],
        ["reset da sessão", until(c.session_reset)],
        ["ritmo atual", pct(c.pace) + " ao dia"],
        ["meta", pct(c.target) + " ao dia"],
        ["reset credits", `${c.reset_credits ?? 0} disponíveis`],
        ["créditos extras", c.credits?.has_credits ? money(c.credits.balance) : "sem saldo"],
      ];
      note = "O ritmo compara o consumo diário com a meta que preserva a folga até o reset. Se o ritmo passar da meta, o sol fica laranja no fim da janela.";
    } else if (key.startsWith("claude") && q.claude?.available) {
      const c = q.claude;
      title = "Claude · cota";
      lines = [
        ["folga semanal", pct(c.week_free)],
        ["reset semanal", until(c.week_reset)],
        ["folga da sessão", pct(c.session_free)],
        ["reset da sessão", until(c.session_reset)],
        ["crédito total", c.credit_limit != null ? money(c.credit_limit) : "—"],
        ["crédito usado", c.credit_used != null ? money(c.credit_used) : "—"],
        ["crédito livre", c.credit_free != null ? pct(c.credit_free) : "—"],
        ["reset do crédito", until(c.credit_reset)],
      ];
      note = "Esta conexão exige créditos para modelos premium. O erro 429 não é falta de janela: é falta de saldo para o modelo escolhido.";
    } else if (key === "google") {
      provider = "google";
      title = "Google · cota";
      lines = [["status", "sem cota por token"]];
      note = q.google?.error || "O Google/Antigravity não expõe cota por token; acompanhe no painel do provedor.";
    } else {
      note = "Cota não disponível para este provedor.";
    }
    const kb = knowledgeFor(provider);
    openDrawer(`
      <span class="drw-eyebrow">${esc(provMeta(provider).vendor)} · cota local</span>
      <div class="drw-head"><span class="drw-mark" style="--pc:${provColor(provider)}">${esc(provMeta(provider).glyph)}</span><div><h2>${esc(title)}</h2><p>leitura do 9router · ${ago(S.meta.router_age)}</p></div></div>
      <div class="drw-section" style="margin-top:4px">${lines.map(([k, v]) => `<div class="drw-line"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
      <div class="drw-note">${esc(note)}</div>
      ${kb ? `<div class="drw-section"><h3>Como manter a folga</h3>${kb.manage.slice(0, 4).map((x) => `<div class="drw-line manual"><span>•</span><b>${esc(x)}</b></div>`).join("")}</div>
      <div class="drw-section"><h3>Documentação</h3><div class="drw-actions" style="flex-direction:column;margin-top:6px">${kb.docs.map(([label, url]) => `<button class="btn ghost" data-act="open-url" data-url="${esc(url)}" style="justify-content:flex-start">${esc(label)} ↗</button>`).join("")}</div></div>` : ""}
      <div class="drw-actions"><button class="btn primary" data-act="ask" data-q="${esc(`Como administrar a cota do ${provName(provider)} sem perder qualidade?`)}">Perguntar ao Oráculo</button></div>
    `);
  }

  function openBucketDrawer(i) {
    const item = state.chartItems[i];
    if (!item) return;
    const entries = Object.entries(item.providers || {}).filter(([, v]) => (v?.tokens || 0) > 0).sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
    openDrawer(`
      <span class="drw-eyebrow">${state.bucketKind === "hours" ? "hora" : "dia"} · detalhe local</span>
      <div class="drw-head"><span class="drw-mark" style="--pc:#2f9e6b">◷</span><div><h2>${esc(item.title)}</h2><p>${int(item.requests)} chamadas · ${money(item.cost)}</p></div></div>
      <div class="drw-kpis">
        <div class="drw-kpi"><span>tokens</span><b>${compact(item.tokens)}</b></div>
        <div class="drw-kpi"><span>chamadas</span><b>${int(item.requests)}</b></div>
        <div class="drw-kpi"><span>custo</span><b>${money(item.cost)}</b></div>
        <div class="drw-kpi"><span>provedores</span><b>${entries.length}</b></div>
      </div>
      <div class="drw-section"><h3>Distribuição</h3>
        ${entries.map(([k, v]) => `<div class="drw-line"><span>${esc(provName(k))}</span><b>${compact(v.tokens)} · ${money(v.cost)}</b></div>`).join("") || `<div class="drw-line"><span>sem consumo</span><b>—</b></div>`}
      </div>
      <div class="drw-note">Quer investigar quais chamadas puxaram este bloco? Abra Sessões e ordene por tokens.</div>
      <div class="drw-actions"><button class="btn primary" data-act="wing" data-key="sessoes">Abrir sessões</button><button class="btn ghost" data-act="close" data-close="1">Fechar</button></div>
    `);
  }

  act("close", closeDrawer);

  function openErrorDrawer(i) {
    const e = state.snapshotError(i);
    if (!e) return;
    markReviewed(i);
    openDrawer(`
      <span class="drw-eyebrow">diagnóstico local · sem segredos</span>
      <div class="drw-head"><span class="drw-mark" style="--pc:${e.diagnosis?.tone === "bad" ? "#d8584a" : "#e3a33f"}">!</span><div><h2>${esc(e.diagnosis?.title || "Erro")}</h2><p>${esc(provName(e.provider))} · ${esc(e.model || "—")} · ${e.count} ocorrência${e.count > 1 ? "s" : ""}</p></div></div>
      <div class="drw-section"><h3>Causa provável</h3><div class="drw-note" style="margin-top:0">${esc(e.diagnosis?.cause || "—")}</div></div>
      <div class="drw-section"><h3>Correção sugerida</h3><div class="drw-note" style="margin-top:0">${esc(e.diagnosis?.fix || "—")}</div></div>
      <div class="drw-section"><h3>Mensagem normalizada</h3><div class="drw-note" style="margin-top:0;font-family:JetBrains Mono,monospace;font-size:8px;line-height:1.6">${esc(e.message)}</div></div>
      <div class="drw-section"><h3>Prompt pronto</h3><div class="drw-note" style="margin-top:0;white-space:pre-wrap;max-height:180px;overflow:auto;font-size:8px;line-height:1.6">${esc(e.prompt)}</div></div>
      <div class="drw-actions"><button class="btn primary" data-act="error-copy" data-i="${i}">Copiar prompt</button><button class="btn ghost" data-act="open-url" data-url="${esc(state.snap.router.links?.find((l) => l.label === "Abrir 9router")?.url || "")}">Abrir 9router</button></div>
      <div class="drw-note">Última ocorrência: ${esc(e.last)}. A cópia não inclui chaves, tokens ou trechos de código.</div>
    `);
  }

  function openSessionDrawer(id) {
    const s = state.snap.qoder?.sessions?.find((x) => x.id === id);
    if (!s) return;
    const ctx = (s.context || []).map((c) => `<div class="drw-line"><span>${esc(c.name)}</span><b>${pct(c.pct)}</b></div>`).join("");
    openDrawer(`
      <span class="drw-eyebrow">Qoder Desktop · metadados</span>
      <div class="drw-head"><span class="drw-mark" style="--pc:#3a7fc0">Q</span><div><h2>${esc(s.title)}</h2><p>${esc(s.project)} · ${esc(s.model)} · ${esc(s.mode)}</p></div></div>
      <div class="drw-kpis">
        <div class="drw-kpi"><span>mensagens</span><b>${int(s.messages)}</b></div>
        <div class="drw-kpi"><span>tool calls</span><b>${int(s.tool_calls)}</b></div>
        <div class="drw-kpi"><span>contexto</span><b>${pct(s.context_pct)}</b></div>
        <div class="drw-kpi"><span>leituras dup.</span><b>${int(s.duplicates)}</b></div>
      </div>
      <div class="drw-section"><h3>Composição do contexto</h3>${ctx || `<div class="drw-line"><span>sem snapshot</span><b>—</b></div>`}</div>
      <div class="drw-section"><h3>Local</h3><div class="drw-line"><span>projeto</span><b>${esc(s.cwd || "—")}</b></div><div class="drw-line"><span>atualizada</span><b>${esc(rel(s.updated_at))}</b></div></div>
      <div class="drw-actions"><button class="btn primary" data-act="ask" data-q="${esc(`Analise a sessão ${s.title} (${s.project}) com contexto em ${pct(s.context_pct)} e sugira como reduzir.`)}">Analisar no Oráculo</button></div>
      <div class="drw-note">Apenas metadados: nenhum prompt ou trecho de código é lido para esta tela.</div>
    `);
  }

  function openProjectDrawer(key) {
    const p = (state.snap.projects || []).find((x) => x.name === key);
    if (!p) return;
    const sessions = (state.snap.qoder?.sessions || []).filter((s) => s.project === p.name);
    openDrawer(`
      <span class="drw-eyebrow">projeto local</span>
      <div class="drw-head"><span class="drw-mark" style="--pc:#8b7ad4">${esc(p.name.slice(0, 1).toUpperCase())}</span><div><h2>${esc(p.name)}</h2><p>${esc(p.kind)} · ${esc(p.origin)}</p></div></div>
      <div class="drw-kpis">
        <div class="drw-kpi"><span>sessões</span><b>${int(p.sessions)}</b></div>
        <div class="drw-kpi"><span>IAs</span><b>${(p.ais || []).length}</b></div>
        <div class="drw-kpi"><span>atividade</span><b style="font-size:12px">${esc(p.last_activity || "—")}</b></div>
        <div class="drw-kpi"><span>abertas</span><b>${sessions.length}</b></div>
      </div>
      <div class="drw-section"><h3>Ferramentas</h3><div class="drw-line"><span>AIs</span><b>${esc((p.ais || []).join(", ") || "—")}</b></div><div class="drw-line"><span>caminho</span><b style="max-width:230px;overflow:hidden;text-overflow:ellipsis">${esc(p.path || "—")}</b></div></div>
      ${sessions.length ? `<div class="drw-section"><h3>Sessões recentes</h3>${sessions.slice(0, 5).map((s) => `<button class="drw-line" style="width:100%;text-align:left" data-act="session" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><b>${pct(s.context_pct)}</b></button>`).join("")}</div>` : ""}
      <div class="drw-actions"><button class="btn primary" data-act="ask" data-q="${esc(`Como reduzir o custo e o contexto do projeto ${p.name}?`)}">Pedir plano</button></div>
    `);
  }

  function openRadar(i) {
    const a = allAlerts()[i];
    if (!a) return;
    if (a.budget) {
      openBudgetDrawer();
      return;
    }
    if (a.provider && state.snap.errors?.some((e) => e.provider === a.provider)) {
      openWing("ajuda");
      return;
    }
    openWing("fluxo");
  }

  function stateSnapshotError(i) {
    return state.snap?.errors?.[i];
  }
  state.snapshotError = stateSnapshotError;

  function markReviewed(i) {
    const e = state.snap?.errors?.[i];
    if (!e) return;
    const key = `${e.provider}|${e.model}|${e.diagnosis?.title}`;
    if (state.reviewed.has(key)) return;
    state.reviewed.add(key);
    store.set("reviewed", [...state.reviewed]);
    renderQuests();
    renderXP();
  }

  function copyErrorPrompt(i) {
    const e = state.snap?.errors?.[i];
    if (!e) return;
    markReviewed(i);
    copyText(e.prompt, "Prompt de correção copiado");
  }

  /* ---------------------------------------------------------- palette */

  function paletteEntries() {
    const S = state.snap;
    const entries = [];
    const wicons = {};
    WING_ORDER.forEach((k) => { wicons[k] = railIcon(k); });
    entries.push({ kind: "ala", title: "Atlas", sub: "visão geral", icon: railIcon("atlas"), run: () => { closeWing(); } });
    WING_ORDER.forEach((k) => entries.push({ kind: "ala", title: tr(`nav.${k}`), sub: tr(`wings.${k}.sub`), icon: wicons[k], run: () => openWing(k) }));
    entries.push({ kind: "ação", title: tr("budget.title"), sub: tr("budget.sub"), icon: "", run: openBudgetDrawer });
    entries.push({ kind: "ação", title: tr("settings.title"), sub: tr("settings.currencySub"), icon: "", run: openSettingsDrawer });
    entries.push({ kind: "ação", title: "Atualizar dados agora", sub: "roda o coletor local", icon: "", run: refreshData });
    entries.push({ kind: "ação", title: "Alternar dia / crepúsculo", sub: "muda a iluminação", icon: "", run: toggleLight });
    entries.push({ kind: "ação", title: tr("manual.title"), sub: "5 passos", icon: "", run: () => openManual(0) });
    entries.push({ kind: "ação", title: "Copiar diagnóstico completo", sub: "prompt pronto para sua IA", icon: "", run: () => copyText(buildDiagnosticPrompt(), "Diagnóstico copiado") });
    entries.push({ kind: "ação", title: "Exportar snapshot JSON", sub: "somente dados derivados", icon: "", run: exportJson });
    entries.push({ kind: "ação", title: tr("fluxo.exportCsv"), sub: tr("health.title"), icon: "", run: exportCsv });
    if (S) {
      (S.providers || []).forEach((p) => entries.push({ kind: "provedor", title: provName(p.provider), sub: `${compact(p.tokens)} tokens · ${pct(p.share)} · manual`, color: provColor(p.provider), run: () => openProviderDrawer(p.provider) }));
      (S.models || []).slice(0, 12).forEach((m) => entries.push({ kind: "modelo", title: modelName(m.model), sub: `${provName(m.provider)} · ${compact(m.tokens)} tokens`, color: provColor(m.provider), run: () => { state.focus = m.provider; renderFleet(); renderChart(); openProviderDrawer(m.provider); } }));
      (S.projects || []).slice(0, 10).forEach((p) => entries.push({ kind: "projeto", title: p.name, sub: `${p.sessions} sessões · ${p.last_activity || ""}`, run: () => openProjectDrawer(p.name) }));
      (S.qoder?.sessions || []).slice(0, 10).forEach((s) => entries.push({ kind: "sessão", title: s.title, sub: `${s.project} · ${pct(s.context_pct)} de contexto`, run: () => openSessionDrawer(s.id) }));
      (S.errors || []).slice(0, 8).forEach((e, i) => entries.push({ kind: "erro", title: e.diagnosis?.title || "Erro", sub: `${provName(e.provider)} · ${e.model}`, run: () => { markReviewed(i); openErrorDrawer(i); } }));
    }
    return entries;
  }

  function openPalette() {
    if (!state.snap) return;
    closeDrawer();
    $("#palette").hidden = false;
    void $("#palette").offsetWidth;
    $("#palette").classList.add("open");
    const input = $("#paletteInput");
    input.value = "";
    state.paletteIndex = 0;
    renderPalette("");
    setTimeout(() => input.focus(), 60);
  }

  function closePalette() {
    const p = $("#palette");
    if (p.hidden) return;
    p.classList.remove("open");
    setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 260);
  }

  function renderPalette(query) {
    const all = paletteEntries();
    const q = nkey(query).trim();
    const filtered = (q ? all.filter((e) => nkey(`${e.title} ${e.sub} ${e.kind}`).includes(q)) : all).slice(0, 14);
    state.palette = filtered;
    state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, filtered.length - 1));
    const wrap = $("#paletteResults");
    if (!filtered.length) {
      wrap.innerHTML = `<div class="palette-empty">Nada encontrado para “${esc(query)}”.</div>`;
      return;
    }
    wrap.innerHTML = filtered.map((e, i) => `<button class="pal-item${i === state.paletteIndex ? " sel" : ""}" data-act="palette-run" data-i="${i}" data-kind="${esc(e.kind)}" style="${e.color ? `--pc:${e.color}` : ""}">
      <span class="pal-ico">${e.icon || (e.color ? e.title.slice(0, 1).toUpperCase() : "→")}</span>
      <span class="pal-main"><b>${esc(e.title)}</b><span>${esc(e.sub)}</span></span>
      <span class="pal-kind">${esc(e.kind)}</span>
    </button>`).join("");
    $$(".pal-item", wrap).forEach((el, i) => el.classList.toggle("sel", i === state.paletteIndex));
    const sel = $(".pal-item.sel", wrap);
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function paletteKeys(ev) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (!state.palette.length) return;
      state.paletteIndex = (state.paletteIndex + 1) % state.palette.length;
      renderPalette($("#paletteInput").value);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!state.palette.length) return;
      state.paletteIndex = (state.paletteIndex - 1 + state.palette.length) % state.palette.length;
      renderPalette($("#paletteInput").value);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const entry = state.palette[state.paletteIndex];
      if (entry) { closePalette(); setTimeout(entry.run, 60); }
    }
  }

  /* ---------------------------------------------------------- tour */

  const TOUR = [
    { target: "#sunGauge", title: "A janela é a sua cota", text: "A faixa mostra a folga real da janela do Codex. Clique para alternar entre semana, janela de 5h e Claude. Duplo clique abre o detalhamento." },
    { target: "#fleet", title: "Cada balão é um provedor", text: "O número é a fatia de tokens no período. Clique em um balão para filtrar o gráfico e abrir o manual daquela IA, com documentação oficial." },
    { target: ".chart-wrap", title: "O gráfico é hora a hora", text: "Passe o mouse para ver provedor e custo. Clique numa barra para abrir a hora. A linha do tempo abaixo viaja entre os dias monitorados." },
    { target: ".cockpit", title: "O cockpit decide por você", text: "Agora, provedores, erros diagnosticados com prompt pronto e dicas geradas dos seus números. Tudo baseado no snapshot local." },
    { target: ".rail", title: "Dez alas, um só lugar", text: "Atlas, Fluxo, Sessões, Oficina, Oráculo, Biblioteca, Diário, Guilda, Perfil e Ajuda. Use 1–9 no teclado." },
    { target: "#pipCompanion", title: "Pip lê a sua operação", text: "O assistente é local e rule-based: ele responde com os seus dados sem enviar nada para fora. Clique nele para abrir o Oráculo." },
  ];

  function initTour() { /* start handled after first snapshot */ }

  function startTour() {
    state.tourStep = 0;
    $("#tour").hidden = false;
    renderTour();
  }

  function renderTour() {
    const step = TOUR[state.tourStep];
    if (!step) { endTour(true); return; }
    $("#tourStep").textContent = `TOUR · ${state.tourStep + 1}/${TOUR.length}`;
    $("#tourTitle").textContent = step.title;
    $("#tourText").textContent = step.text;
    $("#tourNext").textContent = state.tourStep === TOUR.length - 1 ? "Concluir" : "Próximo";
    $$(".tour-focus").forEach((el) => el.classList.remove("tour-focus"));
    const target = $(step.target);
    if (target) target.classList.add("tour-focus");
  }

  function advanceTour() {
    if (state.tourStep >= TOUR.length - 1) { endTour(true); return; }
    state.tourStep += 1;
    renderTour();
  }

  function endTour(seen) {
    $("#tour").hidden = true;
    $$(".tour-focus").forEach((el) => el.classList.remove("tour-focus"));
    if (seen) store.set("tourSeen", true);
  }

  /* ---------------------------------------------------------- prompts + export */

  function buildContextPrompt() {
    const S = state.snap;
    if (!S) return "";
    const lines = [
      "Contexto Rune (local, sem segredos):",
      `- Hoje: ${int(S.today.tokens)} tokens, ${S.today.requests} chamadas, ${money(S.today.cost)}, cache ${pct(S.totals.cacheHit)}.`,
      `- Período: ${int(S.totals.requests)} chamadas, ${compact(S.totals.tokens)} tokens, ${money(S.totals.cost)}.`,
      `- Provedores: ${(S.providers || []).map((p) => `${provName(p.provider)} ${pct(p.share)} / ${compact(p.tokens)} tokens`).join("; ")}.`,
      S.quota?.codex?.available ? `- Codex: folga semanal ${pct(S.quota.codex.week_free)} e de sessão ${pct(S.quota.codex.session_free)}; ritmo ${pct(S.quota.codex.pace)} vs meta ${pct(S.quota.codex.target)}.` : "",
      S.errors?.length ? `- Erros abertos: ${S.errors.map((e) => `${provName(e.provider)}/${e.model}: ${e.diagnosis?.title}`).slice(0, 8).join("; ")}.` : "- Sem erros abertos no período.",
      `- Qoder: ${S.qoder?.sessions?.length || 0} sessões, ${S.qoder?.skills?.total || 0} skills, ${S.qoder?.duplicates?.length || 0} arquivos com leitura repetida.`,
      `- Desperdício estimado em leituras repetidas: ${compact((S.qoder?.duplicates || []).reduce((a, b) => a + (b.wasted || 0), 0))} tokens.`,
    ].filter(Boolean);
    lines.push("", "Ajude-me a decidir as 3 melhores ações para reduzir custo e risco sem perder qualidade. Não peça nem exponha chaves ou tokens.");
    return lines.join("\n");
  }

  function buildDiagnosticPrompt() {
    const S = state.snap;
    if (!S) return "";
    const errors = (S.errors || []).slice(0, 6).map((e, i) => `${i + 1}. [${provName(e.provider)}/${e.model}] ${e.diagnosis?.title}: ${e.message} | causa: ${e.diagnosis?.cause} | correção: ${e.diagnosis?.fix}`).join("\n");
    return [
      "Diagnóstico Rune (local, sem segredos)",
      `Gerado em ${S.meta.now_label}.`,
      "",
      "Métricas:",
      `- Hoje: ${int(S.today.tokens)} tokens / ${S.today.requests} chamadas / ${money(S.today.cost)} / cache ${pct(S.totals.cacheHit)}.`,
      `- Período: ${compact(S.totals.tokens)} tokens / ${int(S.totals.requests)} chamadas / ${money(S.totals.cost)}.`,
      `- Provedores: ${(S.providers || []).map((p) => `${provName(p.provider)} ${pct(p.share)}`).join(", ")}.`,
      "",
      "Cotas:",
      S.quota?.codex?.available ? `- Codex semana: ${pct(S.quota.codex.week_free)} livre, reset em ${until(S.quota.codex.week_reset)}.` : "- Codex sem cota exposta.",
      S.quota?.claude?.available ? `- Claude semana: ${pct(S.quota.claude.week_free)} livre; crédito ${pct(S.quota.claude.credit_free || 0)}.` : "- Claude sem cota exposta.",
      "",
      "Erros:",
      errors || "- Nenhum.",
      "",
      "Peça: (1) causa raiz, (2) correção segura no 9router, (3) fallback e retry, (4) o que monitorar. Não peça chaves nem tokens."
    ].join("\n");
  }

  function buildReport() {
    const S = state.snap;
    if (!S) return "";
    const rows = (S.series || []).slice(-7).map((d) => `| ${d.label} | ${int(d.requests)} | ${compact(d.tokens)} | ${money(d.cost)} |`).join("\n");
    return [
      "# Rune · relatório local",
      "",
      `Gerado em ${S.meta.now_label}. Nenhum prompt ou chave incluído.`,
      "",
      "## Hoje",
      `- ${int(S.today.tokens)} tokens em ${int(S.today.requests)} chamadas`,
      `- Custo ${money(S.today.cost)} · cache ${pct(S.totals.cacheHit)}`,
      "",
      "## Provedores",
      ...(S.providers || []).map((p) => `- ${provName(p.provider)}: ${pct(p.share)} · ${compact(p.tokens)} tokens · ${money(p.cost)}`),
      "",
      "## Últimos dias",
      "| dia | chamadas | tokens | custo |",
      "| --- | ---: | ---: | ---: |",
      rows,
      "",
      "## Cotas",
      S.quota?.codex?.available ? `- Codex: ${pct(S.quota.codex.week_free)} de folga semanal, ${pct(S.quota.codex.session_free)} na sessão.` : "- Codex: sem cota exposta.",
      S.quota?.claude?.available ? `- Claude: ${pct(S.quota.claude.week_free)} de folga semanal, crédito ${pct(S.quota.claude.credit_free || 0)}.` : "- Claude: sem cota exposta.",
      "",
      "## Erros diagnosticados",
      ...(S.errors || []).slice(0, 5).map((e) => `- ${provName(e.provider)}/${e.model}: ${e.diagnosis?.title} — ${e.diagnosis?.fix}`),
      "",
      "---",
      "Rune · local-first · 127.0.0.1",
    ].join("\n");
  }

  function exportJson() {
    const S = state.snap;
    if (!S) return;
    const safe = {
      meta: S.meta,
      totals: S.totals,
      series: S.series,
      providers: S.providers,
      models: S.models,
      quota: S.quota,
      errors: (S.errors || []).map((e) => ({ provider: e.provider, model: e.model, message: e.message, count: e.count, last: e.last, code: e.code, diagnosis: e.diagnosis })),
      qoder: S.qoder,
      inventory: S.inventory,
      projects: S.projects,
      router: S.router,
    };
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rune-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Snapshot exportado · somente metadados derivados");
  }

  /* ============================================================
     AS DEZ ALAS
     ============================================================ */

  const WING_RENDERERS = {};

  /* ---------------------------------------------------------- dados derivados */

  const usageFor = (key) => (state.snap?.providers || []).find((p) => p.provider === key) || null;
  const connFor = (key) => (state.snap?.connections || []).find((c) => c.provider === key) || null;
  const sumDup = () => (state.snap?.qoder?.duplicates || []).reduce((a, b) => a + (b.wasted || 0), 0);
  const shortPath = (v) => String(v || "").replace(/^\/Users\/[^/]+/, "~");

  function connectedKeys() {
    const S = state.snap;
    const seen = new Set();
    const out = [];
    [...(S.providers || []).map((p) => p.provider), ...(S.connections || []).map((c) => c.provider)]
      .forEach((k) => { if (k && !seen.has(k)) { seen.add(k); out.push(k); } });
    return out;
  }

  function quotaFor(key) {
    const q = state.snap?.quota || {};
    if (key === "codex") return q.codex;
    if (key === "claude") return q.claude;
    if (key === "antigravity" || key === "gemini" || key === "gemini-cli") return q.google;
    return null;
  }

  function quotaBadge(key) {
    if (key === "nvidia") return { text: "custo zero", cls: "ok" };
    if (key === "ollama") return { text: "local", cls: "ok" };
    if (key === "openrouter") return { text: "créditos", cls: "info" };
    const q = quotaFor(key);
    if (q?.available && q.week_free != null) return { text: `${pct(q.week_free, 0)} livre`, cls: q.week_free > 40 ? "ok" : "warn" };
    if (q?.available && q.credit_free != null) return { text: `${pct(q.credit_free, 0)} crédito`, cls: "warn" };
    return { text: "sem cota API", cls: "warn" };
  }

  function providerStatus(key) {
    const c = connFor(key);
    if (!c) return { text: "não conectada", cls: "warn" };
    if (c.status === "active") return { text: "ativa", cls: "ok" };
    if (c.errorCode) return { text: `erro ${c.errorCode}`, cls: "bad" };
    return { text: c.status || "off", cls: "warn" };
  }

  /* ------------------------------------------------------------ frota viva */

  function fleetOwners() {
    return (state.snap?.fleet?.owners || []).filter((o) => o.connection);
  }

  function fleetKeys() {
    const seen = new Set();
    const out = [];
    const add = (k) => { if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
    fleetOwners().forEach((o) => add(o.connection));
    (state.snap?.connections || []).forEach((c) => add(c.provider));
    return out;
  }

  function fleetFor(key) {
    return fleetOwners().find((o) => o.connection === key) || null;
  }

  function probeFor(key) {
    return state.probes[key] || null;
  }

  // O servidor guarda o último resultado de cada rota; a aba só precisa lembrar dele.
  function hydrateProbes(routes) {
    (routes || []).forEach((r) => {
      if (!r || !r.connection) return;
      const at = Date.parse(r.checked_at || "") || 0;
      const local = state.probes[r.connection];
      if (local && local.status !== "idle" && (local.at || 0) >= at) return;
      state.probes[r.connection] = { status: r.ok ? "ok" : "fail", at, ...r };
    });
  }

  function shortAge(ms) {
    if (!ms) return "";
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return "agora";
    if (mins < 60) return `${mins} min`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
  }

  function probeChip(key) {
    const p = probeFor(key);
    if (!p) return `<span class="fl-chip idle">${esc(tr("fleet.chipIdle"))}</span>`;
    if (p.status === "running") return `<span class="fl-chip run"><i></i>${esc(tr("fleet.testing"))}</span>`;
    const age = shortAge(p.at);
    const title = age ? ` title="${esc(tr("fleet.probedAgo", { age }))}"` : "";
    if (p.status === "ok") return `<span class="fl-chip ok"${title}>${esc(tr("fleet.chipOk", { ms: int(p.ms || 0) }))}</span>`;
    const code = p.code ? ` ${p.code}` : "";
    return `<span class="fl-chip bad"${title}>${esc(tr("fleet.chipFail"))}${esc(code)}</span>`;
  }

  function fleetMessage(key) {
    const p = probeFor(key);
    if (!p || p.status !== "fail") return "";
    return friendlyError(p.error) || "sem resposta";
  }

  const PROBE_HINTS = {
    400: "requisição recusada",
    401: "sem credencial válida",
    402: "sem créditos ou assinatura",
    403: "acesso negado pela assinatura",
    404: "rota ou conta inexistente",
    410: "modelo descontinuado",
    429: "limite de requisições atingido",
    500: "erro interno do provedor",
    502: "upstream sem resposta",
    503: "provedor indisponível",
  };

  function friendlyError(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const low = text.toLowerCase();
    const code = Number((text.match(/\[(\d{3})\]/) || [])[1] || 0);
    const detail = (text.match(/"(?:message|detail|error)"\s*:\s*"([^"]{3,140})/) || [])[1] || "";
    const guess =
      /(model|modelo)[^.]{0,40}(not found|retired|unavailable|unsupported|end of life)/.test(low) ? "modelo indisponível no provedor"
      : /(credit|billing|payment|subscribe|plan)/.test(low) ? "sem créditos ou assinatura"
      : /(rate limit|too many requests|quota exceeded)/.test(low) ? "limite de requisições atingido"
      : /(unauthor|invalid.{0,12}key|api key)/.test(low) ? "credencial inválida"
      : /(forbidden|permission|access denied)/.test(low) ? "acesso negado"
      : PROBE_HINTS[code] || "";
    if (guess && detail) return `${guess} · ${detail}`;
    if (guess) return guess;
    if (detail) return detail;
    return text.replace(/^\[[^\]]*\]\s*/, "").replace(/^\[?\d{3}\]?:\s*/, "").replace(/[{}"]/g, "").slice(0, 140);
  }

  function repaintFleet() {
    if (state.fleetPaint) return;
    state.fleetPaint = requestAnimationFrame(() => {
      state.fleetPaint = null;
      if (state.wing === "biblioteca") renderWing("biblioteca", { preserve: true });
      if (state.drawerKey && $("#drawer").classList.contains("open")) openProviderDrawer(state.drawerKey);
      if (!state.wing) { renderPortHud(); renderPortInspector(); }
    });
  }

  async function runProbe(connection, opts = {}) {
    if (!opts.queued && state.probes[connection]?.status === "running") return;
    state.probes[connection] = { status: "running", at: Date.now() };
    repaintFleet();
    try {
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection, force: !opts.queued }),
      });
      const data = await res.json();
      state.probes[connection] = { status: data.ok ? "ok" : "fail", at: Date.now(), ...data };
    } catch (err) {
      state.probes[connection] = { status: "fail", at: Date.now(), error: String(err.message || err) };
    }
    repaintFleet();
  }

  async function runProbeAll() {
    if (state.probingAll) return;
    const keys = fleetKeys().filter((k) => state.probes[k]?.status !== "running");
    if (!keys.length) return;
    state.probingAll = true;
    keys.forEach((k) => { state.probes[k] = { status: "running", at: Date.now() }; });
    repaintFleet();
    let cursor = 0;
    // Três sondagens simultâneas: o suficiente para ser rápido sem saturar a máquina.
    const worker = async () => {
      while (cursor < keys.length) await runProbe(keys[cursor++], { queued: true });
    };
    await Promise.all([worker(), worker(), worker()]);
    state.probingAll = false;
    repaintFleet();
    const ok = keys.filter((k) => state.probes[k]?.status === "ok").length;
    toast(tr("fleet.toastProbe", { ok, total: keys.length }), ok === keys.length ? "ok" : "warn");
  }

  async function refreshFleet() {
    toast(tr("fleet.toastUpdating"), "info");
    try {
      await fetch("/api/fleet", { cache: "no-store" });
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applySnapshot(await res.json());
      const f = state.snap?.fleet || {};
      if (f.online) {
        toast(tr("fleet.toastCatalog", {
          models: int(f.total),
          routes: (f.owners || []).length,
          latency: latency(f.latency_ms),
        }));
      } else {
        toast(f.error || tr("fleet.offlineToast"), "bad");
      }
    } catch (err) {
      toast(tr("fleet.toastUnavailable", { err: err.message }), "bad");
    }
  }

  function donutSvg(rows) {
    const total = Math.max(1, rows.reduce((a, b) => a + b.tokens, 0));
    const C = 2 * Math.PI * 40;
    let offset = 0;
    const segs = rows.map((r) => {
      const len = (r.tokens / total) * C;
      const seg = `<circle cx="55" cy="55" r="40" fill="none" stroke="${provColor(r.provider || r.key)}" stroke-width="13" stroke-dasharray="${Math.max(0.5, len).toFixed(2)} ${(C - Math.max(0.5, len)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 55 55)"/>`;
      offset += len;
      return seg;
    }).join("");
    return `<svg viewBox="0 0 110 110" aria-hidden="true">
      <circle cx="55" cy="55" r="40" fill="none" stroke="rgba(30,70,84,.06)" stroke-width="13"/>${segs}
      <text x="55" y="53" text-anchor="middle" font-family="Outfit,sans-serif" font-size="15" font-weight="700" fill="#173c49">${compact(total)}</text>
      <text x="55" y="64" text-anchor="middle" font-family="Inter,sans-serif" font-size="7" fill="#5E6A62">tokens</text>
    </svg>`;
  }

  function projectionSvg(days) {
    const S = state.snap;
    const avgCost = Number(S.totals.avgCost) || 0;
    const todayCost = Number(S.today.cost) || 0;
    const W = 700, H = 208, L = 46, R = 16, T = 14, B = 24, PW = W - L - R, PH = H - T - B;
    const max = Math.max(0.01, avgCost * days, todayCost * days) * 1.08;
    const pts = 13;
    const x = (i) => L + (PW * i) / (pts - 1);
    const y = (v) => T + PH - (v / max) * PH;
    const avg = Array.from({ length: pts }, (_, i) => [x(i), y(avgCost * days * i / (pts - 1))]);
    const tod = Array.from({ length: pts }, (_, i) => [x(i), y(todayCost * days * i / (pts - 1))]);
    const path = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const area = `${path(avg)} ${tod.slice().reverse().map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")} Z`;
    let grid = "";
    for (let i = 0; i <= 4; i++) {
      const gy = T + (PH * i) / 4;
      grid += `<line class="grid" x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}"/>`;
      grid += `<text class="axis" x="${L - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${dec(toDisplay(max * (1 - i / 4)), max >= 10 ? 0 : 1)}</text>`;
    }
    const mid = Math.round((days / 2) * 10) / 10;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${grid}
      <path d="${area}" fill="#c8f169" opacity=".2"/>
      <path class="line" d="${path(avg)}" stroke="#0f1a15"/>
      <path class="proj" d="${path(tod)}" stroke="#ff4b2b"/>
      <circle class="dot" cx="${x(pts - 1)}" cy="${y(avgCost * days)}" r="3.6" fill="#0f1a15"/>
      <circle class="dot" cx="${x(pts - 1)}" cy="${y(todayCost * days)}" r="3.6" fill="#ff4b2b"/>
      <text class="axis" x="${L}" y="${H - 6}" text-anchor="start">hoje</text>
      <text class="axis" x="${L + PW / 2}" y="${H - 6}" text-anchor="middle">+${mid} dias</text>
      <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">+${days} dias</text>
      <text class="axis" x="${W - R - 2}" y="${y(avgCost * days) - 7}" text-anchor="end" fill="#0f1a15">média ${money(avgCost * days)}</text>
      <text class="axis" x="${W - R - 2}" y="${y(todayCost * days) + 12}" text-anchor="end" fill="#C73518">ritmo de hoje ${money(todayCost * days)}</text>
    </svg>`;
  }

  function heatmapHtml() {
    const S = state.snap;
    const rows = S.hours?.[S.today.date] || [];
    const max = Math.max(1, ...rows.map((r) => r.tokens || 0));
    return `<div class="heatmap">${Array.from({ length: 24 }, (_, h) => {
      const row = rows.find((x) => x.hour === h) || { tokens: 0, requests: 0, cost: 0 };
      const ratio = (row.tokens || 0) / max;
      const color = `rgba(255,75,43,${(0.05 + ratio * 0.87).toFixed(2)})`;
      const hot = ratio > 0.55;
      return `<div class="heat-cell${hot ? " hot" : ""}" style="background:${color}" title="${String(h).padStart(2, "0")}:00 · ${compact(row.tokens)} tokens · ${int(row.requests)} chamadas · ${money(row.cost)}">${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>`;
    }).join("")}</div>
    <div class="heat-legend"><span>menos</span><i style="--hc:#ff4b2b;--op:.12"></i><i style="--hc:#ff4b2b;--op:.3"></i><i style="--hc:#ff4b2b;--op:.55"></i><i style="--hc:#ff4b2b;--op:.85"></i><span>mais</span><span style="margin-left:auto">pico: ${compact(max)} tokens numa hora</span></div>`;
  }

  function yearTrendHtml() {
    const months = (state.snap.months || []).filter((m) => m && m.month);
    if (!months.length) {
      return `<div class="drw-note" style="margin-top:10px">${esc(tr("fluxo.yearEmpty"))}</div>`;
    }
    const current = state.snap.month?.month || "";
    const max = Math.max(0.0001, ...months.map((m) => Number(m.cost) || 0));
    const total = months.reduce((sum, m) => sum + (Number(m.cost) || 0), 0);
    const peak = months.reduce((a, b) => ((Number(b.cost) || 0) > (Number(a.cost) || 0) ? b : a), months[0]);
    const bars = months.map((m) => {
      const cost = Number(m.cost) || 0;
      const h = cost > 0 ? Math.max(3, Math.round((cost / max) * 84)) : 2;
      const on = m.month === current ? " on" : "";
      const zero = cost > 0 ? "" : " zero";
      const title = `${m.label} · ${money(cost)} · ${compact(m.tokens || 0)} tokens · ${int(m.requests || 0)} chamadas · cache ${pct(m.cache_hit || 0)}`;
      return `<div class="year-col${on}${zero}" title="${esc(title)}"><i style="height:${h}px"></i><span>${esc(m.label)}</span></div>`;
    }).join("");
    return `<div class="year-strip">${bars}</div>
      <div class="heat-legend"><span>${esc(tr("fluxo.yearPeak"))}: ${esc(peak.label)} · ${money(peak.cost)}</span><span style="margin-left:auto">${esc(tr("fluxo.yearAvg"))}: ${esc(tr("fluxo.yearPerMonth", { v: money(total / months.length) }))}</span></div>`;
  }

  const MANUAL_TASKS = [
    { key: "code", label: "Código no repositório", pick: "codex", alt: "antigravity", why: "Precisa ler arquivos, editar, rodar testes e iterar com ferramentas. O Codex é o agente mais maduro para esse ciclo; o Antigravity cobre o mesmo terreno quando o trabalho é multimodal ou exige planejamento visual.", watch: "Sessões longas inflam o input fixo. Reaproveite cache e desligue plugins/MCP que não usa." },
    { key: "text", label: "Texto e análise crítica", pick: "claude", alt: "gemini", why: "Quando a resposta precisa de nuance, justificativa e contexto longo, o Claude tende a ser mais cuidadoso. O Gemini entra bem para contexto enorme e custo menor.", watch: "Modelos premium do Claude exigem créditos nesta conexão; confira o saldo antes de um bloco longo." },
    { key: "image", label: "Imagem, PDF e vídeo", pick: "gemini", alt: "antigravity", why: "Gemini é multimodal por padrão e lida bem com documentos, imagens e mídia. O Antigravity usa a mesma família em um fluxo agêntico de projeto.", watch: "Mídia consome muitos tokens. Reduza resolução/trechos e use modelos flash quando a tarefa permitir." },
    { key: "volume", label: "Volume e classificação", pick: "nvidia", alt: "openrouter", why: "Para muitos itens simples, o custo domina. O NVIDIA NIM está com custo zero no seu plano atual; o OpenRouter oferece modelos baratos e fallback com a mesma API.", watch: "Modelos abertos variam mais. Rode uma amostra de qualidade antes de migrar um pipeline inteiro." },
    { key: "privacy", label: "Dados sensíveis / offline", pick: "ollama", alt: null, why: "Nada sai da máquina. O limite é hardware, não cota de nuvem. Use para dados que não podem trafegar e para experimentos locais.", watch: "Modelos grandes sem VRAM suficiente degradam. Escolha quantização/tamanho e rode um modelo por vez." },
    { key: "fallback", label: "Fallback e comparação", pick: "openrouter", alt: "nvidia", why: "Uma única API para comparar modelos e trocar de provedor quando um cai. Ideal como camada de resiliência e para testar alternativas.", watch: "Defina limite de crédito e acompanhe por modelo. Sem limite, fallback vira gasto silencioso." },
    { key: "research", label: "Pesquisa e contexto enorme", pick: "gemini", alt: "claude", why: "Contextos muito longos e documentos grandes são o terreno do Gemini. O Claude compete quando o que importa é a qualidade da síntese.", watch: "Contexto grande não é gratuito: cache e recorte de documentos são as alavancas." },
  ];

  const MANUAL_ORDER = ["codex", "claude", "antigravity", "gemini", "gemini-cli", "openrouter", "nvidia", "ollama", "cloudflare-ai", "opencode"];

  const CHANGELOG = [
    { date: "03/11/2026", title: "v0.1 · Atlas vivo", text: "Dez alas, cota do Codex e do Claude, gráfico hora a hora, mapa de calor e radar de risco. Histórico de 12 meses, orçamentos no servidor, alertas fora da aba e exportação contábil em CSV.", now: true },
    { date: "02/11/2026", title: "Cotas e coletores", text: "Leitura somente-local do 9router, Qoder Desktop e coletor. Sanitização de chaves, redaction de contas e servidor em 127.0.0.1.", now: false },
    { date: "01/11/2026", title: "Frota e projetos", text: "Inventário de conexões, modelos, combos, projetos e sessões. Primeiros diagnósticos de erro com prompt de correção.", now: false },
    { date: "31/10/2026", title: "Fundação", text: "Primeiro snapshot derivado: tokens, custo, cache e distribuição por provedor. Nenhum prompt persistido.", now: false },
  ];

  const ROADMAP = [
    { key: "core", title: "Núcleo local-first", sub: "9router + Qoder + coletor, sem nuvem", status: "feito", base: 0 },
    { key: "manual", title: "Manual da Frota", sub: "decisor de IA com docs oficiais", status: "feito", base: 0 },
    { key: "share", title: "Cartão compartilhável", sub: "imagem do resumo semanal", status: "próximo", base: 0 },
    { key: "auth", title: "Login opcional GitHub", sub: "só para comunidade, nunca para os dados", status: "planejado", base: 0 },
    { key: "templates", title: "Templates da Guilda", sub: "combos, políticas e manuais da comunidade", status: "planejado", base: 0 },
    { key: "sdk", title: "SDK de coletores", sub: "plugue qualquer IDE ou roteador", status: "planejado", base: 0 },
  ];

  /* ============================================================ FLUXO */

  WING_RENDERERS.fluxo = () => {
    const S = state.snap;
    const t = S.totals;
    const today = S.today;
    const q = S.quota?.codex;
    const days = state.projectionDays;
    const avgCost = Number(t.avgCost) || 0;
    const todayCost = Number(today.cost) || 0;
    const providers = (S.providers || []).slice(0, 4);
    const daysRows = (S.series || []).slice(-7).reverse();
    const maxDay = Math.max(1, ...daysRows.map((d) => d.tokens));
    const yearTotal = (S.months || []).reduce((sum, m) => sum + (Number(m.cost) || 0), 0);
    return `
      <div class="w-hero">
        <div class="big">${compact(t.tokens)}<small> tokens</small></div>
        <div class="copy">
          <b>${int(t.requests)} chamadas em ${t.activeDays} dias ativos</b>
          <p>Hoje foram <b>${compact(today.tokens)} tokens</b> e <b>${money(today.cost)}</b>. A média dos dias ativos é ${compact(t.avgTokens)} tokens e ${money(t.avgCost)} por dia. O gráfico projeta os dois ritmos para você decidir antes do reset.</p>
        </div>
        <div class="side">
          <button class="btn primary" data-act="sim-days" data-days="${days === 7 ? 30 : 7}">${days === 7 ? "Projetar 30 dias" : "Voltar a 7 dias"}</button>
        </div>
      </div>
      <div class="w-kpis">
        <div class="w-kpi"><span class="k-label"><i></i>hoje</span><b>${compact(today.tokens)}</b><em>${int(today.requests)} chamadas · ${money(today.cost)}</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#3e6bff"></i>cache</span><b>${pct(t.cacheHit)}</b><em>${compact(t.cached)} tokens reaproveitados</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#ff4b2b"></i>projeção ${days}d</span><b>${money(avgCost * days)}</b><em>no ritmo de hoje: ${money(todayCost * days)}</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#c8f169"></i>folga Codex</span><b>${q?.available ? pct(q.week_free, 0) : "—"}</b><em>${q?.available ? `reset em ${until(q.week_reset)}` : "cota não exposta"}</em></div>
      </div>
      <div class="w-grid three">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Projeção de gasto</h3><p>média dos dias ativos vs ritmo de hoje · próximos ${days} dias</p></div><span class="pill info">${days} dias</span></div>
          <div class="w-graph">${projectionSvg(days)}</div>
          <div class="proj-box" style="margin-top:6px">
            <div class="proj-read"><b>${money(avgCost * days)}</b><span>se manter a média · <b>${money(todayCost * days)}</b> se repetir hoje (parcial)</span></div>
            <div class="proj-line"><span>Simular outro horizonte</span><div class="sim-btns">${[7, 14, 30].map((d) => `<button class="btn ${d === days ? "primary" : "ghost"}" data-act="sim-days" data-days="${d}">${d}d</button>`).join("")}</div></div>
          </div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Quem puxa o consumo</h3><p>${providers.length} provedores no período</p></div><span class="pill">${money(t.cost)}</span></div>
          <div class="w-donut">${donutSvg(providers)}<div class="w-legend">${providers.map((p) => `<div class="lg-row"><i style="background:${provColor(p.provider)}"></i><span>${esc(provName(p.provider))}</span><b>${pct(p.share, 0)}</b></div>`).join("")}</div></div>
          <div class="w-card-head" style="margin:14px 0 6px"><div><h3 style="font-size:11px">Cota agora</h3><p>leitura local do 9router</p></div></div>
          ${[["codex", S.quota?.codex], ["claude", S.quota?.claude]].map(([k, x]) => x?.available ? `<div class="proj-line" style="margin-bottom:7px"><span>${esc(provName(k))} · semana</span><b style="font-size:11px">${pct(x.week_free, 0)} livre</b></div><div class="w-bar" style="margin-bottom:9px"><i style="width:${clamp(x.week_free)}%;--bc:${provColor(k)}"></i></div>` : "").join("")}
          <div class="proj-line"><span>ritmo / meta Codex</span><b style="font-size:10px">${q?.available ? `${pct(q.pace)} / ${pct(q.target)}` : "—"}</b></div>
        </div>
      </div>
      ${budgetWingCard()}
      ${healthCard()}
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Mapa de calor · hoje</h3><p>onde as horas foram consumidas</p></div><span class="pill info">${compact(today.tokens)} tokens</span></div>
        ${heatmapHtml()}
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>${esc(tr("fluxo.yearTitle"))}</h3><p>${esc(tr("fluxo.yearSub"))}</p></div><span class="pill">${money(yearTotal)}</span></div>
        ${yearTrendHtml()}
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Últimos dias</h3><p>comparado com a média dos dias ativos</p></div><span class="pill">${money(t.cost)} no total</span></div>
        <div class="w-table days-table">
          <div class="w-row head" style="grid-template-columns:minmax(0,1fr) 76px 90px 86px 90px"><span>dia</span><span>chamadas</span><span>tokens</span><span>custo</span><span>vs média</span></div>
          ${daysRows.map((d) => {
            const delta = t.avgTokens ? ((d.tokens - t.avgTokens) / t.avgTokens) * 100 : 0;
            return `<div class="w-row" style="grid-template-columns:minmax(0,1fr) 76px 90px 86px 90px">
              <span class="r-main"><b>${esc(d.label)}</b><span>${esc(weekdayName(dateObj(d.date) || new Date()).replace(/^./, (c) => c.toUpperCase()))}</span></span>
              <span class="num">${int(d.requests)}</span>
              <span class="num">${compact(d.tokens)}</span>
              <span class="num">${money(d.cost)}</span>
              <span class="num" style="color:${delta > 0 ? "var(--signal-ink)" : "var(--blue-ink)"}">${delta > 0 ? "▲" : "▼"} ${pct(Math.abs(delta), 0)}</span>
            </div>`;
          }).join("")}
        </div>
        <div class="drw-note" style="margin-top:10px">A projeção usa a média dos dias ativos, não a média calendário: dias sem chamada não diluem o ritmo. “Ritmo de hoje” é um limite superior porque o dia ainda está em curso.</div>
      </div>
    `;
  };

  /* ============================================================ SESSÕES */

  function sessionList() {
    const S = state.snap;
    const q = nkey(state.sessionQuery).trim();
    let rows = (S.qoder?.sessions || []).filter((s) => !q || nkey(`${s.title} ${s.project} ${s.model}`).includes(q));
    const sort = state.sessionSort;
    rows = rows.slice().sort((a, b) => {
      if (sort === "context") return (b.context_pct || 0) - (a.context_pct || 0);
      if (sort === "messages") return (b.messages || 0) - (a.messages || 0);
      if (sort === "dupes") return (b.duplicates || 0) - (a.duplicates || 0);
      return String(b.updated_at).localeCompare(String(a.updated_at));
    });
    return rows;
  }

  function contextAverage() {
    const sessions = state.snap?.qoder?.sessions || [];
    if (!sessions.length) return [];
    const bucket = new Map();
    sessions.forEach((s) => (s.context || []).forEach((c) => {
      const cur = bucket.get(c.name) || { name: c.name, total: 0, n: 0 };
      cur.total += Number(c.pct) || 0;
      cur.n += 1;
      bucket.set(c.name, cur);
    }));
    return [...bucket.values()].map((x) => ({ name: x.name, pct: x.total / Math.max(1, x.n) })).sort((a, b) => b.pct - a.pct);
  }

  WING_RENDERERS.sessoes = () => {
    const S = state.snap;
    const all = S.qoder?.sessions || [];
    const rows = sessionList();
    const q = state.sessionQuery;
    const msgs = all.reduce((a, s) => a + (s.messages || 0), 0);
    const calls = all.reduce((a, s) => a + (s.tool_calls || 0), 0);
    const avgCtx = all.length ? all.reduce((a, s) => a + (s.context_pct || 0), 0) / all.length : 0;
    const ctx = contextAverage();
    const pressure = all.slice().sort((a, b) => (b.context_pct || 0) - (a.context_pct || 0)).slice(0, 3);
    return `
      <div class="w-hero">
        <div class="big">${all.length}<small> sessões</small></div>
        <div class="copy"><b>${int(msgs)} mensagens · ${int(calls)} tool calls</b><p>Metadados do Qoder Desktop: contexto, mensagens e ferramentas. Nenhum prompt ou trecho de código é lido. A coluna de contexto mostra quanto da janela já foi ocupado antes de compactar.</p></div>
        <div class="side"><button class="btn ghost" data-act="copy-context">Copiar contexto</button><button class="btn primary" data-act="ask" data-q="Quais sessões estão com contexto alto e como reduzir?">Pedir plano</button></div>
      </div>
      <div class="w-kpis">
        <div class="w-kpi"><span class="k-label"><i></i>contexto médio</span><b>${pct(avgCtx, 0)}</b><em>${pressure.filter((s) => s.context_pct >= 50).length} sessões acima de 50%</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#3e6bff"></i>mensagens</span><b>${int(msgs)}</b><em>${(msgs / Math.max(1, all.length)).toFixed(1).replace(".", ",")} por sessão</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#0f1a15"></i>tool calls</span><b>${int(calls)}</b><em>${(calls / Math.max(1, all.length)).toFixed(0)} por sessão</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:#ff4b2b"></i>leituras dup.</span><b>${sumDup() ? compact(sumDup()) : "0"}</b><em>${(S.qoder?.duplicates || []).length} arquivos relidos</em></div>
      </div>
      <div class="w-toolbar">
        <label class="w-search">${railIcon("sessoes")}<input id="sessionSearch" value="${esc(q)}" placeholder="Buscar sessão, projeto ou modelo…" aria-label="Buscar sessões"></label>
        <span class="tag-mini" id="sessionCount">${rows.length} de ${all.length}</span>
        ${[["context", "contexto"], ["messages", "mensagens"], ["dupes", "duplicatas"], ["recent", "recentes"]].map(([k, label]) => `<button class="task-chip ${state.sessionSort === k ? "on" : ""}" data-act="session-sort" data-key="${k}">${label}</button>`).join("")}
      </div>
      <div class="w-grid three">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Sessões monitoradas</h3><p>clique para ver composição do contexto</p></div><span class="pill">${pct(avgCtx, 0)} médio</span></div>
          <div class="w-table sessions-table">
            <div class="w-row head" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr) 42px 48px 40px 62px"><span>sessão</span><span>contexto</span><span>msg</span><span>tools</span><span>dup</span><span>vista</span></div>
            ${rows.map((s) => {
              const ctxSeg = (s.context || []).map((c) => `<i style="width:${clamp(c.pct)}%;background:${ctxColor(c.name)}"></i>`).join("");
              return `<button class="w-row" data-session-row data-search="${esc(`${s.title} ${s.project} ${s.model}`)}" data-act="session" data-id="${esc(s.id)}" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr) 42px 48px 40px 62px">
                <span class="r-main" style="display:block"><b style="display:block">${esc(s.title)}</b><span>${esc(s.project)} · ${esc(s.model)}<em class="r-when"> · ${esc(rel(s.updated_at))}</em></span></span>
                <span><span class="ctx-bar">${ctxSeg}</span><small style="font-family:var(--mono);font-size:8px;color:var(--muted)">${pct(s.context_pct, 0)}</small></span>
                <span class="num">${int(s.messages)}</span>
                <span class="num">${int(s.tool_calls)}</span>
                <span class="num" style="color:${s.duplicates ? "var(--signal-ink)" : "var(--muted)"}">${int(s.duplicates)}</span>
                <span class="num" style="font-size:8px;font-family:var(--mono);font-weight:500;color:var(--muted)">${esc(rel(s.updated_at))}</span>
              </button>`;
            }).join("") || `<div class="w-empty">Nenhuma sessão encontrada para “${esc(q)}”.</div>`}
          </div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Onde o contexto vai</h3><p>média entre as sessões</p></div></div>
          <div class="w-legend">${ctx.map((c) => `<div class="lg-row"><i style="background:${ctxColor(c.name)}"></i><span>${esc(c.name.replace(/_/g, " "))}</span><b>${pct(c.pct, 0)}</b></div>`).join("")}</div>
          <div class="w-card-head" style="margin:14px 0 6px"><div><h3 style="font-size:11px">Sob pressão</h3><p>maiores contextos agora</p></div></div>
          ${pressure.map((s) => `<button class="dup-item" style="width:100%;text-align:left" data-act="session" data-id="${esc(s.id)}"><span class="dup-file"><b style="font-family:Inter,sans-serif;font-size:9px;font-weight:600">${esc(s.title)}</b><span>${esc(s.project)}</span></span><span class="dup-cost" style="color:var(--signal-ink)">${pct(s.context_pct, 0)}</span></button>`).join("") || `<div class="w-empty">Sem sessões.</div>`}
          <div class="drw-note">Contexto alto não é só custo: ele reduz a margem para a próxima mensagem e força compactação. Abra a sessão para ver a composição.</div>
        </div>
      </div>
    `;
  };

  /* ============================================================ OFICINA */

  WING_RENDERERS.oficina = () => {
    const S = state.snap;
    const qd = S.qoder || {};
    const skills = qd.skills || { total: 0, included: 0, top: [] };
    const dup = qd.duplicates || [];
    const wasted = sumDup();
    const art = qd.artifacts || { images: 0, attachments: 0, fileChanges: 0 };
    const inv = S.inventory || {};
    const codex = inv.codex || {};
    const qinv = inv.qoder || {};
    const hygiene = (S.suggestions || []).slice(0, 5);
    const top = (skills.top || []).slice(0, 8);
    const maxSkill = Math.max(0.01, ...top.map((s) => s.pct || 0));
    return `
      <div class="w-hero">
        <div class="big">${int(skills.total)}<small> skills</small></div>
        <div class="copy"><b>${int(wasted)} tokens reprocessados em ${dup.length} arquivos</b><p>A Oficina mostra o que entra no contexto sem aparecer no gráfico: skills carregadas, artefatos e arquivos lidos mais de uma vez na mesma sessão. É aqui que o desperdício silencioso aparece.</p></div>
        <div class="side"><button class="btn ghost" data-act="ask" data-q="Como reduzir o desperdício de leituras repetidas e skills?">Pedir plano</button><button class="btn primary" data-act="copy-context">Copiar contexto</button></div>
      </div>
      <div class="w-kpis">
        <div class="w-kpi"><span class="k-label"><i></i>skills carregadas</span><b>${int(skills.total)}</b><em>${int(skills.included)} incluídas no contexto</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--blue)"></i>artefatos</span><b>${int(art.images + art.attachments + art.fileChanges)}</b><em>${int(art.images)} imagens · ${int(art.fileChanges)} mudanças</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--signal)"></i>reprocessado</span><b>${compact(wasted)}</b><em>${pct((wasted / Math.max(1, S.totals.input)) * 100)} do input do período</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--ink)"></i>plugins</span><b>${int(qinv.pluginsEnabled || 0)}/${int(qinv.plugins || 0)}</b><em>Qoder · Codex: ${int(codex.pluginsEnabled || 0)}/${int(codex.plugins || 0)}</em></div>
      </div>
      <div class="w-grid">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Livro-caixa do desperdício</h3><p>mesmo arquivo lido várias vezes na sessão</p></div><span class="pill warn">${compact(wasted)} tokens</span></div>
          ${dup.map((d) => `<div class="dup-item"><span class="dup-file"><b title="${esc(d.path)}">${esc(shortPath(d.path))}</b><span>${int(d.reads)} leituras · ${compact(d.wasted)} tokens desperdiçados</span></span><span class="dup-cost">${compact(d.wasted)}</span></div>`).join("") || `<div class="w-empty">Nenhuma leitura repetida detectada.</div>`}
          <div class="drw-note">A estimativa usa o tamanho do arquivo dividido por 4. Não é uma cobrança: é o volume que voltou ao contexto sem necessidade.</div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Artefatos e superfície</h3><p>o que a operação produz e carrega</p></div></div>
          <div class="w-subgrid">
            <div class="w-mini"><span>imagens</span><b>${int(art.images)}</b><em>no período</em></div>
            <div class="w-mini"><span>anexos</span><b>${int(art.attachments)}</b><em>arquivos</em></div>
            <div class="w-mini"><span>mudanças</span><b>${int(art.fileChanges)}</b><em>edições</em></div>
          </div>
          <div class="w-card-head" style="margin:14px 0 6px"><div><h3 style="font-size:11px">Higiene da frota</h3><p>plugins e MCP entram no input fixo</p></div></div>
          <div class="w-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="r-main"><b>Codex plugins</b><span>${int(codex.pluginsEnabled || 0)} ativos de ${int(codex.plugins || 0)}</span></span><span class="tag-mini warn">revisar</span></div>
          <div class="w-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="r-main"><b>Codex MCP</b><span>${int(codex.mcp || 0)} servidores</span></span><span class="tag-mini">${int(codex.mcp || 0)}</span></div>
          <div class="w-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="r-main"><b>Qoder plugins</b><span>${int(qinv.pluginsEnabled || 0)} ativos de ${int(qinv.plugins || 0)}</span></span><span class="tag-mini ok">enxuto</span></div>
          <div class="w-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="r-main"><b>Headroom</b><span>${S.router?.headroom?.online ? "compressor online" : "compressor offline"}</span></span><span class="tag-mini ${S.router?.headroom?.online ? "ok" : "warn"}">${S.router?.headroom?.online ? "online" : "offline"}</span></div>
        </div>
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Skills mais carregadas</h3><p>participação no contexto das sessões</p></div><span class="pill">${int(skills.total)} no total</span></div>
        <div class="w-table">
          ${top.map((s, i) => `<div class="w-row" style="grid-template-columns:24px minmax(0,1.4fr) minmax(0,1fr) 48px"><span class="w-rank${i === 0 ? " top" : ""}">${i + 1}</span><span class="r-main" style="display:block"><b style="display:block">${esc(s.name)}</b><span>${esc(s.source)}</span></span><span class="w-bar"><i style="width:${clamp((s.pct / maxSkill) * 100)}%;--bc:#3a8fd0"></i></span><span class="num">${pct(s.pct, 1)}</span></div>`).join("") || `<div class="w-empty">Nenhuma skill carregada.</div>`}
        </div>
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Fila de higiene</h3><p>sinais que custam contexto ou disponibilidade</p></div><span class="pill ${hygiene.length ? "warn" : "ok"}">${hygiene.length} itens</span></div>
        ${hygiene.map((s) => `<button class="w-row" style="grid-template-columns:minmax(0,1.3fr) minmax(0,2fr) auto;width:100%;text-align:left" data-act="ask" data-q="${esc(`Como resolvo: ${s.title}?`)}"><span class="r-main"><b>${esc(s.title)}</b><span>${s.level === "warn" ? "atenção" : "nota"}</span></span><span class="r-txt" style="font-size:8.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(String(s.detail).slice(0, 110))}</span><span class="tag-mini ${s.level === "warn" ? "warn" : ""}">${s.level === "warn" ? "agir" : "ok"}</span></button>`).join("") || `<div class="w-empty">Nada na fila.</div>`}
      </div>
    `;
  };

  /* ============================================================ ORÁCULO */

  function oracleReply(text) {
    const S = state.snap;
    const q = nkey(text);
    const qd = S.quota?.codex;
    const qc = S.quota?.claude;
    const line = (s) => `<li>${s}</li>`;
    if (/folga|cota|quota|limite|sol|reset/.test(q)) {
      const bits = [];
      if (qd?.available) bits.push(line(`Codex: <b>${pct(qd.week_free)}</b> de folga na semana, <b>${pct(qd.session_free)}</b> na janela de 5h. Reset semanal em ${esc(until(qd.week_reset))}.`));
      if (qc?.available) bits.push(line(`Claude: <b>${pct(qc.week_free)}</b> de folga semanal e <b>${pct(qc.credit_free || 0)}</b> de crédito. O 429 é de crédito, não de janela.`));
      bits.push(line(`Ritmo Codex: <b>${pct(qd?.pace || 0)}</b> ao dia contra meta de <b>${pct(qd?.target || 0)}</b>. ${qd && qd.pace < qd.target ? "Você está abaixo da meta; há espaço." : "Você está acima da meta; reduza o ritmo até o reset."}`));
      bits.push(line("Para preservar: reuse a mesma sessão (cache), evite anexos grandes e desligue plugins/MCP que não usa."));
      return `<b>Folga real da frota</b><ul>${bits.join("")}</ul><span style="display:block;margin-top:6px;color:var(--muted)">Clique no sol para alternar as janelas. Duplo clique abre o detalhamento.</span>`;
    }
    if (/qual ia|qual usar|melhor ia|tarefa|comparar|escolher|decis|manual/.test(q)) {
      const pick = MANUAL_TASKS.slice(0, 4).map((t) => line(`<b>${esc(t.label)}</b> → ${esc(provName(t.pick))}${t.alt ? ` (alternativa: ${esc(provName(t.alt))})` : ""}`)).join("");
      return `<b>Decisor rápido</b><ul>${pick}</ul>Para uma decisão com os seus números, abra a Biblioteca: o Manual da Frota cruza finalidade, cota, custo e documentação oficial de cada IA conectada.`;
    }
    if (/custo|gast|econom|reduz|barat|caro|orçamento|orcamento/.test(q)) {
      const top = S.insights?.mostExpensive;
      return `<b>Onde o dinheiro está</b><ul>${line(`Hoje: <b>${money(S.today.cost)}</b> em ${int(S.today.requests)} chamadas.`)}${line(`Custo médio por chamada: <b>${money(S.insights?.costPerReq || 0)}</b>.`)}${top ? line(`Modelo mais caro: <b>${esc(modelName(top.model))}</b> com ${money(top.cost)} (${pct(top.share, 0)} do volume).`) : ""}${line(`Cache em <b>${pct(S.totals.cacheHit)}</b>: ${compact(S.totals.cached)} tokens reaproveitados.`)}</ul>Três alavancas: (1) manter o cache alto, (2) mandar volume simples para NVIDIA/OpenRouter, (3) reservar modelos grandes para arquitetura e depuração difícil.`;
    }
    if (/erro|falha|403|429|diagn|corrig|9router/.test(q)) {
      const errs = (S.errors || []).slice(0, 5).map((e) => line(`<b>${esc(provName(e.provider))} · ${esc(e.diagnosis?.title || "Erro")}</b> (${e.count}×): ${esc(e.diagnosis?.fix || "")}`)).join("");
      return `<b>Diagnóstico aberto</b><ul>${errs || line("Nenhum erro no período.")}</ul>Abra a Ajuda para copiar um prompt pronto com causa, correção e política de fallback.`;
    }
    if (/cache/.test(q)) {
      return `<b>Cache</b><ul>${line(`Acerto atual: <b>${pct(S.totals.cacheHit)}</b>.`)}${line(`${compact(S.totals.cached)} de ${compact(S.totals.input)} tokens de input foram reaproveitados.`)}${line("Para manter: continue na mesma sessão, repita o mesmo prefixo de sistema e evite reordenar anexos.")}</ul>`;
    }
    if (/sessao|contexto|compact/.test(q)) {
      const top = (S.qoder?.sessions || []).slice().sort((a, b) => (b.context_pct || 0) - (a.context_pct || 0)).slice(0, 3);
      return `<b>Pressão de contexto</b><ul>${top.map((s) => line(`<b>${esc(s.title)}</b> (${esc(s.project)}): ${pct(s.context_pct, 0)} · ${int(s.messages)} mensagens`)).join("") || line("Sem sessões monitoradas.")}</ul>Se o contexto passa de 50%, a próxima mensagem pode forçar compactação. Abra a sessão e veja o que está ocupando espaço.`;
    }
    if (/skill|desperd|leitura|duplic|arquivo/.test(q)) {
      const d = (S.qoder?.duplicates || []).slice(0, 3);
      return `<b>Desperdício silencioso</b><ul>${line(`${compact(sumDup())} tokens reprocessados em ${(S.qoder?.duplicates || []).length} arquivos.`)}${d.map((x) => line(`${esc(shortPath(x.path))}: ${int(x.reads)} leituras, ${compact(x.wasted)} tokens`)).join("")}</ul>Peça ao agente para reler só o trecho alterado e use busca antes de abrir o arquivo inteiro.`;
    }
    if (/projeto/.test(q)) {
      return `<b>Projetos com mais sessões</b><ul>${(S.projects || []).slice(0, 5).map((p) => line(`<b>${esc(p.name)}</b>: ${int(p.sessions)} sessões · ${esc((p.ais || []).join(", "))}`)).join("")}</ul>Abra Sessões para ver contexto e duplicatas por projeto.`;
    }
    if (/projec|futuro|30 dias|semana|mês|mes/.test(q)) {
      return `<b>Projeção</b><ul>${line(`Média dos dias ativos: <b>${money(S.totals.avgCost)}</b>/dia → <b>${money(S.totals.avgCost * 7)}</b> em 7 dias e <b>${money(S.totals.avgCost * 30)}</b> em 30.`)}${line(`Ritmo de hoje (parcial): <b>${money(S.today.cost)}</b> → <b>${money(S.today.cost * 7)}</b> em 7 dias.`)}${line(`Folga Codex: ${pct(qd?.week_free || 0)}.`)}</ul>Use o simulador do Fluxo para trocar o horizonte e comparar os dois ritmos.`;
    }
    return `<b>Resumo da operação</b><ul>${line(`Hoje: <b>${compact(S.today.tokens)} tokens</b> em ${int(S.today.requests)} chamadas, ${money(S.today.cost)}.`)}${line(`Cache: <b>${pct(S.totals.cacheHit)}</b> · ${compact(S.totals.cached)} tokens reaproveitados.`)}${line(`Provedor líder: <b>${esc(provName(S.insights?.topProvider?.provider))}</b> com ${pct(S.insights?.topProvider?.share || 0)}.`)}${line(`Folga Codex: <b>${pct(qd?.week_free || 0)}</b> · Claude: <b>${pct(qc?.week_free || 0)}</b>.`)}${line(`${(S.errors || []).length} erros diagnosticados e ${(S.qoder?.duplicates || []).length} arquivos com leitura repetida.`)}</ul>Pergunte “qual IA usar para esta tarefa?”, “onde estou desperdiçando?” ou “como reduzir o custo hoje?”.`;
  }

  function seedChat() {
    if (state.chat.length) return;
    const S = state.snap;
    const q = S.quota?.codex;
    const top = (S.errors || [])[0];
    state.chat = [{
      role: "bot",
      brief: true,
      html: `<div class="ora-brief">
        <div class="ora-brief-head"><span class="dot-live"></span><b>Briefing de agora</b><em>${esc(ago(S.meta.router_age))} · snapshot local</em></div>
        <div class="ora-stats">
          <div><span>tokens hoje</span><b>${compact(S.today.tokens)}</b><small>${int(S.today.requests)} chamadas</small></div>
          <div><span>cache</span><b>${pct(S.totals.cacheHit)}</b><small>${compact(S.totals.cached)} aproveitados</small></div>
          <div><span>custo hoje</span><b>${money(S.today.cost)}</b><small>${money(S.totals.avgCost * 30)} em 30d pela média</small></div>
          <div><span>folga Codex</span><b>${q?.available ? pct(q.week_free, 0) : "—"}</b><small>${q?.available ? `reset em ${until(q.week_reset)}` : "cota não exposta"}</small></div>
        </div>
        ${top ? `<button class="ora-decision" data-act="error-detail" data-i="0">
          <span class="ora-dec-copy"><small>decisão pendente</small><b>${esc(provName(top.provider))} · ${esc(top.diagnosis?.title || "diagnóstico")}</b><em>${esc(top.diagnosis?.fix || top.message)}</em></span>
          <span class="ora-dec-go">abrir</span>
        </button>` : ""}
        <p class="ora-foot">Olá, ${esc(operatorName())}. Leio só o seu snapshot: ${int((S.errors || []).length)} diagnósticos abertos, ${int(S.qoder?.sessions?.length || 0)} sessões e ${manualKeys().length} IAs no manual. Nada sai da máquina.</p>
      </div>`
    }];
  }

  function renderChat() {
    const log = $(".chat-log");
    if (!log) return;
    const S = state.snap;
    const caps = state.chat.length <= 1 ? `<div class="ora-cap">
      <div class="ora-cap-head">ir direto ao ponto</div>
      <div class="ora-cap-grid">
        ${[
          ["Manual da Frota", `${manualKeys().length} IAs · escolha por tarefa`, "biblioteca"],
          ["Sessões Qoder", `${int(S.qoder?.sessions?.length || 0)} sessões · ${int(S.qoder?.skills?.length || 0)} skills`, "sessoes"],
          ["Fluxo e projeção", `${money(S.totals.avgCost * 30)} em 30 dias`, "fluxo"],
          ["Radar de riscos", `${int((S.errors || []).length)} diagnósticos abertos`, "ajuda"],
        ].map(([title, sub, wing]) => `<button data-act="wing" data-key="${wing}"><span><b>${esc(title)}</b><small>${esc(sub)}</small></span><i>→</i></button>`).join("")}
      </div>
      <div class="ora-scan">
        <div class="ora-scan-head">o que eu já reparei</div>
        ${[
          S.insights?.topProvider ? [`${provName(S.insights.topProvider.provider)} puxa ${pct(S.insights.topProvider.share, 0)} do volume`, `${compact(S.insights.topProvider.tokens)} tokens · ${money(S.insights.topProvider.cost)}`] : null,
          [`${pct(S.totals.tokens ? ((S.insights?.freeTokensEstimate || 0) / S.totals.tokens) * 100 : 0, 0)} do consumo veio de graça`, `${compact(S.insights?.freeTokensEstimate || 0)} tokens sem custo`],
          [`Hoje está ${int(S.insights?.todayVsPrev || 0)}% acima de ontem`, `${money(S.insights?.costPerReq || 0)} por chamada`],
        ].filter(Boolean).map(([label, value]) => `<div class="ora-scan-row"><i></i><b>${esc(label)}</b><em>${esc(value)}</em></div>`).join("")}
      </div>
      <div class="ora-cap-foot">cada resposta é calculada no seu snapshot local · sem modelo na nuvem</div>
    </div>` : "";
    log.innerHTML = state.chat.map((m) => `<div class="chat-msg ${m.role === "me" ? "me" : "bot"}${m.brief ? " brief" : ""}">${m.role === "me" ? esc(m.text || "") : m.html}</div>`).join("") + caps;
    log.scrollTop = log.scrollHeight;
  }

  function sendChat(text) {
    const value = String(text || "").trim();
    if (!value || !state.snap) return;
    if (!state.wing) openWing("oraculo");
    state.chat.push({ role: "me", text: value });
    state.chat.push({ role: "bot", html: oracleReply(value) });
    renderChat();
    const input = $("#chatInput");
    if (input) { input.value = ""; input.focus(); }
  }

  WING_RENDERERS.oraculo = () => {
    const S = state.snap;
    seedChat();
    const seeds = [
      "Qual IA usar para cada tarefa?",
      "Onde estou desperdiçando?",
      "Quanta folga eu tenho?",
      "Como reduzir o custo hoje?",
      "O que está com erro?",
    ];
    return `<div class="oraculo">
      <div class="chat-shell">
        <div class="chat-log" aria-live="polite"></div>
        <div class="chat-quick">${seeds.map((s) => `<button data-act="chat-quick" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>
        <div class="chat-input">
          <input id="chatInput" placeholder="Pergunte sobre cota, custo, erro, sessão ou qual IA usar…" autocomplete="off" aria-label="Mensagem para o Oráculo">
          <button class="btn primary" data-act="chat-send">Enviar</button>
          <button class="btn ghost" data-act="clear-chat" title="Limpar conversa">Limpar</button>
        </div>
      </div>
      <div class="chat-side">
        <div class="w-card"><div class="w-card-head"><div><h3 style="font-size:11px">Sinais que eu leio</h3><p>snapshot local</p></div></div>
          <div class="src-list">${(S.meta.sources || []).map((s) => `<div class="src-row"><span class="src-dot ${s.status === "ok" ? "" : "stale"}"></span><span class="src-main"><b>${esc(s.label)}</b><span>${esc(shortPath(s.path))}</span></span><span class="tag-mini ${s.status === "ok" ? "ok" : "warn"}">${esc(s.status)}</span></div>`).join("")}</div>
        </div>
        <div class="w-card"><div class="w-card-head"><div><h3 style="font-size:11px">Como eu respondo</h3><p>sem modelo na nuvem</p></div></div>
          <p>Minhas respostas são montadas por regras sobre os seus números. Eu não envio prompts, não leio código e não guardo o histórico fora do navegador.</p>
          <div class="privacy-list" style="margin-top:8px">${["Respostas determinísticas e auditáveis", "Sem chave de API e sem custo por mensagem", "Histórico só nesta aba", "Você pode copiar o contexto para a sua IA preferida"].map((x) => `<div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg><span>${esc(x)}</span></div>`).join("")}</div>
        </div>
        <div class="w-card"><div class="w-card-head"><div><h3 style="font-size:11px">Atalhos</h3><p>dentro do Oráculo</p></div></div><div class="shortcut-grid">${[["Enviar", "↵"], ["Fechar", "esc"], ["Busca global", "⌘K"], ["Atualizar", "R"]].map(([a, b]) => `<div class="shortcut"><span>${a}</span><kbd>${b}</kbd></div>`).join("")}</div></div>
      </div>
    </div>`;
  };

  /* ============================================================ BIBLIOTECA · MANUAL DA FROTA */

  function manualKeys() {
    const connected = connectedKeys();
    const extras = MANUAL_ORDER.filter((k) => !connected.includes(k) && KNOWLEDGE[k]);
    return [...connected, ...extras];
  }

  function manualTask() {
    return MANUAL_TASKS.find((t) => t.key === state.manualTask) || MANUAL_TASKS[0];
  }

  WING_RENDERERS.biblioteca = () => {
    const S = state.snap;
    const keys = manualKeys();
    const connected = connectedKeys();
    const task = manualTask();
    const pickKb = knowledgeFor(task.pick);
    const altKb = task.alt ? knowledgeFor(task.alt) : null;
    const pickUsage = usageFor(task.pick);
    const freeShare = S.totals.tokens ? ((S.insights?.freeTokensEstimate || 0) / S.totals.tokens) * 100 : 0;
    const statusCount = connected.filter((k) => providerStatus(k).cls === "ok").length;
    const fleet = S.fleet || {};
    const owners = fleetOwners();
    const fkeys = fleetKeys();
    const probed = fkeys.filter((k) => probeFor(k));
    const fleetOk = probed.filter((k) => probeFor(k).status === "ok").length;
    const fleetFail = probed.filter((k) => probeFor(k).status === "fail").length;
    const fleetIdle = fkeys.length - probed.length;
    // Quem está quebrado aparece primeiro: o painel existe para mostrar onde agir.
    const fleetRank = (k) => {
      const p = probeFor(k);
      if (p) return p.status === "fail" ? 0 : p.status === "ok" ? 2 : 1;
      return connFor(k)?.status === "active" ? 1 : 0;
    };
    const fleetOrder = [...fkeys].sort((a, b) => fleetRank(a) - fleetRank(b) || (fleetFor(b)?.models || 0) - (fleetFor(a)?.models || 0));
    const fleetNote = fleet.online
      ? tr("fleet.onlineNote", { ms: latency(fleet.latency_ms), models: int(fleet.total), routes: owners.length })
      : tr("fleet.offlineNote");
    return `
      <div class="manual-hero">
        <div class="manual-copy">
          <h3>Manual da Frota</h3>
          <p>Nove IAs plugadas, nove jeitos de gastar. Esta ala reúne a <b>finalidade de cada IA</b>, o que ela faz melhor que as outras, o que evitar e as alavancas reais para administrar consumo e cota. A decisão vem antes do prompt.</p>
        </div>
        <div class="manual-now">
          <span class="mn-label">sua frota agora</span>
          <div class="mn-big">${connected.length}<small> IAs plugadas</small></div>
          <div class="mn-row"><span>conexões saudáveis</span><b>${statusCount} de ${connected.length}</b></div>
          <div class="mn-row"><span>rotas no 9router</span><b>${fkeys.length}${fleet.online ? ` · ${int(fleet.total)} modelos` : " · offline"}</b></div>
          <div class="mn-row"><span>volume gratuito</span><b>${pct(freeShare, 0)}</b></div>
          <div class="mn-row"><span>provedores medindo</span><b>${(S.providers || []).length}</b></div>
          <div class="mn-row"><span>manual atualizado</span><b>3 nov 2026</b></div>
        </div>
      </div>
      <section class="w-card fleet-live">
        <div class="w-card-head">
          <div><h3>${esc(tr("fleet.live"))}</h3><p>${esc(fleetNote)}</p></div>
          <div class="fl-tools">
            <span class="fl-signal ${fleet.online ? "on" : "off"}"><i></i>${fleet.online ? "online" : "offline"}</span>
            <button class="btn ghost" data-act="fleet-refresh">${esc(tr("fleet.loadCatalog"))}</button>
            <button class="btn primary" data-act="probe-all"${state.probingAll ? " disabled" : ""}>${esc(state.probingAll ? tr("fleet.testing") : tr("fleet.testAll"))}</button>
          </div>
        </div>
        <div class="fl-summary">
          <div><b>${int(fleet.total || 0)}</b><span>${esc(tr("fleet.modelsCatalogued"))}</span></div>
          <div><b>${owners.length}</b><span>${esc(tr("fleet.routesCount"))}</span></div>
          <div class="ok"><b>${fleetOk}</b><span>${esc(tr("fleet.answering"))}</span></div>
          <div class="${fleetFail ? "bad" : ""}"><b>${fleetFail}</b><span>${esc(tr("fleet.failing"))}</span></div>
          <div><b>${fleetIdle}</b><span>${esc(tr("fleet.untested"))}</span></div>
        </div>
        <div class="fl-list">
          ${fleetOrder.map((k) => {
            const meta = provMeta(k);
            const f = fleetFor(k);
            const p = probeFor(k);
            const conn = connFor(k);
            const caps = f ? [f.vision && tr("fleet.capVision"), f.tools && tr("fleet.capTools"), f.reasoning && tr("fleet.capReasoning"), f.free && tr("fleet.capFree")].filter(Boolean) : [];
            const msg = p?.status === "ok"
              ? (p.model || "")
              : (fleetMessage(k) || friendlyError(conn?.error) || "");
            const cls = p ? (p.status === "ok" ? "ok" : p.status === "fail" ? "bad" : "run") : (conn?.status === "active" ? "idle" : "bad");
            return `<div class="fl-row ${cls}" style="--pc:${meta.color}">
              <span class="fl-ai"><i class="fl-dot"></i><b>${esc(meta.name)}</b><em>${esc(f?.key || tr("fleet.noRoute"))}${f ? ` · ${int(f.models)} ${esc(tr("fleet.models"))}` : ""}</em></span>
              <span class="fl-caps">${caps.length ? caps.map((c) => `<span>${esc(c)}</span>`).join("") : `<span class="dim">—</span>`}</span>
              <span class="fl-ctx">${f?.context ? `${compact(f.context)} ctx` : "—"}</span>
              <span class="fl-probe">${probeChip(k)}</span>
              <span class="fl-msg" title="${esc(msg)}">${esc(msg || (p?.model ? p.model : tr("fleet.waitingProbe")))}</span>
              <span class="fl-act"><button class="mini" data-act="probe" data-key="${esc(k)}"${p?.status === "running" ? " disabled" : ""}>${esc(tr("fleet.testShort"))}</button><button class="mini ghost" data-act="provider-detail" data-key="${esc(k)}">${esc(tr("fleet.manualShort"))}</button></span>
            </div>`;
          }).join("")}
        </div>
        <div class="drw-note">${esc(tr("fleet.note"))}</div>
      </section>
      <div class="decision">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Decisor de tarefa</h3><p>escolha o tipo de trabalho e veja a rota recomendada</p></div><span class="pill info">${keys.length} manuais</span></div>
          <div class="task-chips">${MANUAL_TASKS.map((t) => `<button class="task-chip ${t.key === task.key ? "on" : ""}" data-act="manual-task" data-key="${t.key}" style="--pc:${provColor(t.pick)}"><i></i>${esc(t.label)}</button>`).join("")}</div>
          <div class="decision-card">
            <div>
              <h4>${esc(task.label)} → ${esc(provName(task.pick))}</h4>
              <p>${esc(task.why)}</p>
              <div class="drw-note warn" style="margin-top:9px"><b>Atenção:</b> ${esc(task.watch)}</div>
              <div class="drw-actions" style="margin-top:10px">
                <button class="btn primary" data-act="provider-detail" data-key="${esc(task.pick)}">Abrir manual do ${esc(provName(task.pick))}</button>
                <button class="btn ghost" data-act="ask" data-q="${esc(`Como usar ${provName(task.pick)} para ${task.label.toLowerCase()} sem estourar a cota?`)}">Perguntar ao Oráculo</button>
              </div>
            </div>
            <div class="decision-runner">
              <b>rota recomendada</b>
              <div class="run" style="--pc:${provColor(task.pick)}"><i></i><b>${esc(provName(task.pick))}</b><span>${esc(quotaBadge(task.pick).text)}</span></div>
              <div class="run" style="--pc:${provColor(task.alt || task.pick)}"><i></i><b>${esc(task.alt ? provName(task.alt) : "sem alternativa local")}</b><span>${esc(task.alt ? quotaBadge(task.alt).text : "—")}</span></div>
              <div class="run"><i style="background:var(--muted)"></i><b>uso atual</b><span>${pickUsage ? `${pct(pickUsage.share, 0)} do volume` : "sem uso"}</span></div>
              <div class="run"><i style="background:var(--muted)"></i><b>custo no período</b><span>${pickUsage ? money(pickUsage.cost) : "—"}</span></div>
            </div>
          </div>
          ${pickKb ? `<div class="drw-note" style="margin-top:10px">${esc(pickKb.verdict)}${altKb ? ` <b>Alternativa:</b> ${esc(altKb.verdict)}` : ""}</div>` : ""}
        </div>
      </div>
      <div class="w-card matrix">
        <div class="w-card-head"><div><h3>Matriz de decisão</h3><p>finalidade, melhor uso, consumo e cota de cada IA</p></div><span class="pill">${connected.length} conectadas</span></div>
        <div class="w-table">
          <div class="w-row head"><span>IA</span><span>finalidade</span><span>melhor para</span><span>uso</span><span>cota</span><span>manual</span></div>
          ${keys.map((k) => {
            const kb = knowledgeFor(k) || {};
            const u = usageFor(k);
            const qb = quotaBadge(k);
            return `<div class="w-row" style="--pc:${provColor(k)}"><span class="r-ai"><i></i><b>${esc(provName(k))}</b></span><span class="r-txt">${esc(kb.tag || "provedor")}</span><span class="r-txt">${esc((kb.best || [])[0] || "—")}</span><span class="num">${u ? pct(u.share, 0) : "—"}</span><span><span class="tag-mini ${qb.cls}">${esc(qb.text)}</span></span><button class="r-doc" data-act="provider-detail" data-key="${esc(k)}">abrir</button></div>`;
          }).join("")}
        </div>
      </div>
      <div class="fleet-grid" style="margin-top:12px">
        ${keys.map((k) => {
          const kb = knowledgeFor(k) || {};
          const meta = provMeta(k);
          const u = usageFor(k);
          const st = providerStatus(k);
          const qb = quotaBadge(k);
          return `<article class="kb-card" style="--pc:${meta.color}">
            <div class="kb-head"><span class="kb-mark">${esc(meta.glyph)}</span><div><h4>${esc(meta.name)}</h4><span>${esc(meta.vendor || "provedor")} · ${esc(kb.tag || "conectado")}</span></div><div class="kb-tags"><span class="tag-mini ${st.cls}">${esc(st.text)}</span><span class="tag-mini ${qb.cls}">${esc(qb.text)}</span></div></div>
            <p class="kb-purpose">${esc(kb.purpose || "Provedor conectado à frota.")}</p>
            <div class="kb-cols">
              <div class="kb-col"><b>melhor para</b><div class="kb-list">${(kb.best || []).slice(0, 3).map((x) => `<div><i>✓</i><span>${esc(x)}</span></div>`).join("")}</div></div>
              <div class="kb-col"><b>evite quando</b><div class="kb-list avoid">${(kb.avoid || []).slice(0, 3).map((x) => `<div><i>×</i><span>${esc(x)}</span></div>`).join("")}</div></div>
            </div>
            <div class="kb-manage">${(kb.manage || []).slice(0, 3).map((x) => `<div><i>→</i><span>${esc(x)}</span></div>`).join("")}</div>
            <div class="kb-foot"><div class="kb-usage"><span class="w-bar"><i style="width:${clamp(u?.share || 0)}%;--bc:${meta.color}"></i></span><em>${u ? `${compact(u.tokens)} tokens · ${money(u.cost)} · ${pct(u.share, 0)}` : "sem consumo no período"}</em></div>${(kb.docs || []).slice(0, 2).map(([label, url]) => `<button class="kb-doc" data-act="open-url" data-url="${esc(url)}" title="${esc(url)}">${esc(label)} ↗</button>`).join("")}</div>
            <div class="kb-verdict">${esc(kb.verdict || "")}</div>
            <div class="drw-actions" style="margin-top:0"><button class="btn ghost" data-act="provider-detail" data-key="${esc(k)}">Manual completo</button><button class="btn ghost" data-act="focus-only" data-key="${esc(k)}">Filtrar uso</button></div>
          </article>`;
        }).join("")}
      </div>
      <div class="drw-note" style="margin-top:12px">Documentação oficial aberta em nova aba. Os links foram verificados em 3 nov 2026. Nenhuma chave, token ou credencial é exibida nesta ala.</div>
    `;
  };

  /* ============================================================ DIÁRIO */

  WING_RENDERERS.diario = () => {
    const S = state.snap;
    const xp = xpTotals();
    const lv = levelFor(xp.xp);
    const badges = [
      { icon: "☀", label: "4 dias ativos", got: S.totals.activeDays >= 4 },
      { icon: "⚡", label: "cache > 65%", got: S.totals.cacheHit >= 65 },
      { icon: "◈", label: "6M tokens", got: S.totals.tokens >= 6e6 },
      { icon: "✧", label: "9 IAs plugadas", got: connectedKeys().length >= 9 },
      { icon: "⟡", label: "100 skills", got: (S.qoder?.skills?.total || 0) >= 100 },
      { icon: "✓", label: "2 diagnósticos", got: state.reviewed.size >= 2 },
    ];
    return `
      <div class="w-hero">
        <div class="big">${int(S.totals.activeDays)}<small> dias</small></div>
        <div class="copy"><b>Nível ${lv.level} · ${lv.name} · ${int(xp.xp)} XP</b><p>O Diário guarda o que mudou e o que você conquistou. As conquistas usam os seus números reais: cache, volume, frota conectada, skills e diagnósticos revisados.</p></div>
        <div class="side"><button class="btn ghost" data-act="copy-report">Copiar changelog</button><button class="btn primary" data-act="ask" data-q="Como subir de nível no Rune e o que eu já conquistei?">Pedir plano</button></div>
      </div>
      <div class="w-kpis">
        <div class="w-kpi"><span class="k-label"><i></i>XP total</span><b>${int(xp.xp)}</b><em>${xp.today} hoje · faltam ${int(Math.max(0, lv.next - xp.xp))} para o próximo</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--blue)"></i>tokens</span><b>${compact(S.totals.tokens)}</b><em>${int(S.totals.requests)} chamadas</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--lime)"></i>cache</span><b>${pct(S.totals.cacheHit)}</b><em>${compact(S.totals.cached)} reaproveitados</em></div>
        <div class="w-kpi"><span class="k-label"><i style="background:var(--signal)"></i>diagnósticos revisados</span><b>${state.reviewed.size}/${(S.errors || []).length}</b><em>abertos no radar</em></div>
      </div>
      <div class="w-grid three">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Linha do tempo</h3><p>o que entrou em cada versão</p></div><span class="pill info">v0.1</span></div>
          <div class="tl-list">${CHANGELOG.map((c) => `<div class="tl-item${c.now ? "" : " old"}"><div class="tl-date">${esc(c.date)}</div><div class="tl-pin"><i></i></div><div class="tl-content"><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div></div>`).join("")}</div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Seu nível</h3><p>progresso local</p></div><span class="pill">${lv.level}</span></div>
          <div class="proj-read" style="margin-bottom:10px"><b>${lv.level}</b><span>${esc(lv.name)} · ${int(xp.xp)} / ${int(lv.next)} XP</span></div>
          <div class="w-bar" style="height:8px"><i style="width:${lv.progress}%;--bc:var(--signal)"></i></div>
          <div class="proj-line" style="margin-top:10px"><span>Próximo nível</span><b style="font-size:10px">${int(Math.max(0, lv.next - xp.xp))} XP</b></div>
          <div class="proj-line"><span>XP de hoje</span><b style="font-size:10px">+${xp.today}</b></div>
          <div class="drw-note" style="margin-top:10px">Ganhe XP completando missões no Atlas, revisando diagnósticos e explorando alas. O progresso fica no seu navegador.</div>
        </div>
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Conquistas</h3><p>desbloqueadas com dados reais</p></div><span class="pill">${badges.filter((b) => b.got).length} de ${badges.length}</span></div>
        <div class="badge-grid">${badges.map((b) => `<div class="badge${b.got ? " got" : ""}"><span class="b-ico">${b.icon}</span><b>${esc(b.label)}</b><span>${b.got ? "desbloqueada" : "em progresso"}</span></div>`).join("")}</div>
      </div>
    `;
  };

  /* ============================================================ GUILDA */

  WING_RENDERERS.guilda = () => {
    const S = state.snap;
    const votes = state.votes || {};
    const totalVotes = Object.values(votes).reduce((a, b) => a + (Number(b) || 0), 0);
    const supported = ROADMAP.filter((r) => Number(votes[r.key] || 0) > 0).length;
    return `
      <div class="w-hero">
        <div class="big">0<small> dados na nuvem</small></div>
        <div class="copy"><b>Comunidade sem intermediário · ${Object.keys(votes).filter((k) => votes[k] > 0).length} apoios locais</b><p>O Rune nasce local-first. A comunidade vive no GitHub — Issues, Discussions e Wiki — e nenhum dado da sua operação precisa sair da máquina para participar. Esta ala é o ensaio do que será publicado.</p></div>
        <div class="side"><button class="btn ghost" data-act="copy-report">Copiar release</button><button class="btn primary" data-act="export-json">Exportar snapshot</button></div>
      </div>
      <div class="guild-grid">
        <div class="guild-cta">
          <span class="eyebrow" style="font-size:8px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--signal-ink)">próximo capítulo</span>
          <h3>Abra o Rune com a comunidade.</h3>
          <p>O repositório será publicado com o núcleo local, o Manual da Frota e os coletores. Issues para bugs, Discussions para ideias e Wiki para manuais de cada IA. O login GitHub será opcional e nunca vai ler seus dados locais.</p>
          <div class="row"><button class="btn primary" data-act="ask" data-q="Como contribuir com o Rune e o que publicar primeiro?">Como contribuir</button><button class="btn ghost" data-act="copy-diag">Copiar diagnóstico</button><button class="btn ghost" data-act="export-json">Exportar</button></div>
          <div class="w-subgrid guild-stats">
            <div class="w-mini"><span>apoios locais</span><b>${int(totalVotes)}</b><em>neste navegador</em></div>
            <div class="w-mini"><span>itens apoiados</span><b>${supported}/${ROADMAP.length}</b><em>no roadmap</em></div>
            <div class="w-mini"><span>dados na nuvem</span><b>0</b><em>nada sai da máquina</em></div>
          </div>
          <div class="drw-note" style="margin-top:2px">${totalVotes ? `${totalVotes} apoio${totalVotes > 1 ? "s" : ""} registrado${totalVotes > 1 ? "s" : ""} neste navegador.` : "Ainda sem apoios neste navegador. Vote no roadmap abaixo."}</div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Roadmap votável</h3><p>o que entra depois da fundação</p></div><span class="pill">${ROADMAP.length} itens</span></div>
          ${ROADMAP.map((r) => {
            const v = Number(votes[r.key] || 0);
            return `<div class="road-item"><div class="road-main"><b>${esc(r.title)}</b><span>${esc(r.sub)}</span></div><span class="tag-mini ${r.status === "feito" ? "ok" : r.status === "próximo" ? "warn" : ""}">${esc(r.status)}</span><button class="vote${v ? " on" : ""}" data-act="vote" data-key="${esc(r.key)}" title="Apoiar ${esc(r.title)}">▲ ${v}</button></div>`;
          }).join("")}
        </div>
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Como a Guilda funciona</h3><p>três caminhos, nenhum obrigatório</p></div></div>
        <div class="w-subgrid">
          <div class="w-mini"><span>issues</span><b>bugs</b><em>erro reproduzível + snapshot derivado</em></div>
          <div class="w-mini"><span>discussions</span><b>ideias</b><em>manuais, decisores e integrações</em></div>
          <div class="w-mini"><span>wiki</span><b>manuais</b><em>uma página por IA e por fonte de dados</em></div>
        </div>
        <div class="drw-note">O diagnóstico copiado não contém chaves, tokens ou trechos de código. Você escolhe o que compartilhar.</div>
      </div>
    `;
  };

  /* ============================================================ PERFIL */

  WING_RENDERERS.perfil = () => {
    const S = state.snap;
    const keys = connectedKeys();
    const xp = xpTotals();
    const lv = levelFor(xp.xp);
    const sources = S.meta.sources || [];
    return `
      <div class="profile-grid">
        <div class="profile-card">
          <div class="profile-id"><span class="profile-avatar">${esc(operatorName().slice(0, 1).toUpperCase())}</span><div><b>${esc(operatorName())}</b><span>operador local · ${esc(S.meta.now_label)}</span></div></div>
          <div class="profile-stats">
            <div><span>nível</span><b>${lv.level} · ${esc(lv.name)}</b></div>
            <div><span>XP</span><b>${int(xp.xp)}</b></div>
            <div><span>dias ativos</span><b>${int(S.totals.activeDays)}</b></div>
            <div><span>sessões</span><b>${int(S.qoder?.sessions?.length || 0)}</b></div>
          </div>
          <div class="drw-note" style="margin-top:11px">Perfil local. Não há conta, senha ou login. O identificador serve só para a gamificação desta máquina.</div>
          <div class="drw-actions"><button class="btn primary" data-act="export-json">Exportar JSON</button><button class="btn ghost" data-act="copy-diag">Copiar diagnóstico</button></div>
        </div>
        <div class="profile-card">
          <div class="w-card-head"><div><h3>Conexões da frota</h3><p>${keys.length} provedores · nenhuma credencial exibida</p></div><span class="pill">9router</span></div>
          <div class="w-table">
            ${keys.map((k) => {
              const c = connFor(k);
              const st = providerStatus(k);
              return `<div class="w-row" style="grid-template-columns:minmax(0,1fr) 90px 110px 80px"><span class="r-main"><b>${esc(provName(k))}</b><span>${esc(c?.auth || "—")} · ${esc(maskEmail(c?.name || "—"))}</span></span><span class="tag-mini ${st.cls}">${esc(st.text)}</span><span class="num" style="font-size:8px;font-family:Inter,sans-serif;font-weight:500;color:var(--muted)">${esc(c?.plan || "—")}</span><span class="num" style="font-size:8px;font-family:Inter,sans-serif;font-weight:500;color:var(--muted)">${c?.expiresAt ? `expira ${until(c.expiresAt)}` : "—"}</span></div>`;
            }).join("")}
          </div>
        </div>
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>${esc(tr("settings.title"))}</h3><p>${esc(tr("settings.currencySub"))}</p></div><button class="btn ghost" data-act="settings">${esc(tr("common.configure"))}</button></div>
        <div class="drw-line"><span>${esc(tr("perfil.operator"))}</span><b><input class="op-input" id="operatorInput" maxlength="24" value="${esc(operatorName())}" aria-label="${esc(tr("perfil.operator"))}"></b></div>
        <div class="drw-line"><span>${esc(tr("perfil.language"))}</span><b>${esc((I18N?.languages || []).find((l) => l.code === state.lang)?.label || state.lang)}</b></div>
        <div class="drw-line"><span>${esc(tr("perfil.currency"))}</span><b>${esc(CURRENCIES[state.currency])} · ${esc(state.currency)}</b></div>
        <div class="drw-line"><span>${esc(tr("perfil.rates"))}</span><b>USD ${Number(state.rates.USD || 0).toFixed(2)} · EUR ${Number(state.rates.EUR || 0).toFixed(2)}</b></div>
      </div>
      <div class="w-card sec-card" id="secBox" style="margin-top:12px">${securityBody()}</div>
      <div class="w-grid" style="margin-top:12px">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Fontes locais</h3><p>somente leitura · caminhos reais</p></div><span class="pill info">${sources.length}</span></div>
          <div class="src-list">${sources.map((s) => `<div class="src-row"><span class="src-dot ${s.status === "ok" ? "" : "stale"}"></span><span class="src-main"><b>${esc(s.label)}</b><span>${esc(shortPath(s.path))}</span></span><span class="tag-mini ${s.status === "ok" ? "ok" : "warn"}">${esc(s.status)}</span></div>`).join("")}</div>
          <div class="drw-note">O servidor abre os bancos em modo somente-leitura e escuta apenas em 127.0.0.1.</div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Privacidade</h3><p>o contrato do Rune</p></div><span class="pill ok">local</span></div>
          <div class="privacy-list">${(S.meta.privacy || []).map((p) => `<div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg><span>${esc(p)}</span></div>`).join("")}</div>
        </div>
      </div>
      <div class="w-grid" style="margin-top:12px">
        <div class="w-card">
          <div class="w-card-head"><div><h3>Chaves do 9router</h3><p>somente identificadores mascarados</p></div><span class="pill">${(S.keys || []).length}</span></div>
          ${(S.keys || []).map((k) => `<div class="key-row"><span class="tag-mini ${k.active ? "ok" : "warn"}">${k.active ? "ativa" : "off"}</span><span class="key-code">${esc(k.keyId)}••••</span><span class="tag-mini ${k.restricted ? "warn" : ""}">${k.restricted ? "restrita" : "livre"}</span><span class="num" style="margin-left:auto;font-size:9px">${esc(k.name)}</span></div>`).join("") || `<div class="w-empty">Nenhuma chave.</div>`}
          <div class="drw-note">O valor completo da chave nunca é lido pela interface. O 9router continua exigindo a chave para proteger a exposição via túnel.</div>
        </div>
        <div class="w-card">
          <div class="w-card-head"><div><h3>Atalhos</h3><p>navegue sem mouse</p></div></div>
          <div class="shortcut-grid">${[["Busca global", "⌘K"], ["Atualizar dados", "R"], ["Alternar luz", "D"], ["Tour guiado", "?"], ["Alas 1–9", "1…9"], ["Fechar camada", "esc"]].map(([a, b]) => `<div class="shortcut"><span>${a}</span><kbd>${b}</kbd></div>`).join("")}</div>
        </div>
      </div>
    `;
  };

  /* ============================================================ AJUDA */

  WING_RENDERERS.ajuda = () => {
    const S = state.snap;
    const errors = S.errors || [];
    const reviewed = errors.filter((e) => state.reviewed.has(`${e.provider}|${e.model}|${e.diagnosis?.title}`)).length;
    return `
      <div class="w-hero">
        <div class="big">${errors.length}<small> diagnósticos</small></div>
        <div class="copy"><b>${reviewed} revisados · ${errors.reduce((a, e) => a + (e.count || 0), 0)} ocorrências</b><p>Cada erro já vem com causa provável, correção sugerida e um prompt pronto para colar na sua IA preferida. O prompt não inclui chave, token OAuth ou trecho de código.</p></div>
        <div class="side"><button class="btn ghost" data-act="copy-diag">Copiar diagnóstico</button><button class="btn primary" data-act="open-url" data-url="${esc(S.router.links?.find((l) => l.label === "Abrir 9router")?.url || "")}">Abrir 9router</button></div>
      </div>
      <div class="fleet-grid">
        ${errors.length ? errors.map((e, i) => {
          const isReviewed = state.reviewed.has(`${e.provider}|${e.model}|${e.diagnosis?.title}`);
          const tone = e.diagnosis?.tone === "bad" ? "var(--signal)" : "#e6a62d";
          return `<article class="help-card" style="border-left:2px solid ${tone}">
            <div class="w-card-head"><div><h3>${esc(e.diagnosis?.title || "Erro")}</h3><p>${esc(provName(e.provider))} · ${esc(e.model || "—")} · ${e.count}× · ${esc(rel(e.last))}</p></div><span class="tag-mini ${isReviewed ? "ok" : "bad"}">${isReviewed ? "revisado" : "aberto"}</span></div>
            <p class="err-msg">${esc(e.message)}</p>
            <div class="why"><b>Causa provável:</b> ${esc(e.diagnosis?.cause || "—")}<br><b>Correção:</b> ${esc(e.diagnosis?.fix || "—")}</div>
            <div class="drw-actions"><button class="btn primary" data-act="error-copy" data-i="${i}">Copiar prompt</button><button class="btn ghost" data-act="error-detail" data-i="${i}">Detalhes</button></div>
          </article>`;
        }).join("") : `<div class="w-card"><div class="w-empty">Nenhum erro no período. O céu está limpo.</div></div>`}
      </div>
      <div class="w-card" style="margin-top:12px">
        <div class="w-card-head"><div><h3>Como o Rune diagnostica</h3><p>regras locais sobre a mensagem normalizada</p></div><span class="pill info">sem IA na nuvem</span></div>
        <div class="w-subgrid">
          <div class="w-mini"><span>1 · normalizar</span><b>mensagem</b><em>status HTTP + erro aninhado + código do provedor</em></div>
          <div class="w-mini"><span>2 · classificar</span><b>causa</b><em>credencial, cota, modelo aposentado, rota ou falha do provedor</em></div>
          <div class="w-mini"><span>3 · prescrever</span><b>ação</b><em>correção segura + fallback + o que monitorar</em></div>
        </div>
        <div class="drw-note">Se a causa não estiver nas regras, o prompt pronto leva o contexto para a sua IA preferida. Nada é enviado automaticamente.</div>
      </div>
    `;
  };

  /* ============================================================ bindings das alas */

  function bindWing(key) {
    if (key === "perfil") {
      loadSecurity();
      const op = $("#operatorInput");
      if (op) {
        op.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); op.blur(); } });
        op.addEventListener("change", () => {
          const value = op.value.trim().slice(0, 24);
          state.operator = value;
          store.set("operator", value);
          renderHero();
          const name = $(".profile-id b");
          if (name) name.textContent = operatorName();
          toast(tr("perfil.operatorSaved"));
        });
      }
    }
    if (key === "sessoes") {
      const input = $("#sessionSearch");
      if (input) {
        input.value = state.sessionQuery;
        input.addEventListener("input", () => {
          state.sessionQuery = input.value;
          filterSessionRows();
        });
      }
    }
    if (key === "oraculo") {
      const input = $("#chatInput");
      if (input) {
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            sendChat(input.value);
          }
        });
      }
      renderChat();
    }
  }

  function filterSessionRows() {
    const q = nkey(state.sessionQuery).trim();
    let shown = 0;
    $$("[data-session-row]").forEach((el) => {
      const on = !q || nkey(el.dataset.search || "").includes(q);
      el.hidden = !on;
      if (on) shown += 1;
    });
    const count = $("#sessionCount");
    const total = state.snap?.qoder?.sessions?.length || 0;
    if (count) count.textContent = `${shown} de ${total}`;
  }

  function setProjection(days) {
    const next = [7, 14, 30].includes(Number(days)) ? Number(days) : 7;
    state.projectionDays = next;
    if (state.wing === "fluxo") {
      renderWing("fluxo", { preserve: true });
      toast(`Projeção ajustada para ${next} dias`);
    } else {
      openWing("fluxo");
    }
  }

  function vote(key) {
    if (!ROADMAP.some((r) => r.key === key)) return;
    state.votes[key] = Number(state.votes[key] || 0) + 1;
    store.set("votes", state.votes);
    if (state.wing === "guilda") renderWing("guilda", { preserve: true });
    const item = ROADMAP.find((r) => r.key === key);
    toast(`Apoio registrado · ${item.title}`);
  }

  act("manual-task", (el) => {
    state.manualTask = el.dataset.key || "code";
    if (state.wing === "biblioteca") renderWing("biblioteca", { preserve: true });
  });
  act("session-sort", (el) => {
    state.sessionSort = el.dataset.key || "context";
    if (state.wing === "sessoes") renderWing("sessoes", { preserve: true });
  });
  act("chat-send", () => {
    const input = $("#chatInput");
    if (input) sendChat(input.value);
  });

  /* ---------------------------------------------------------- go */

  boot();
})();
