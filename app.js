// URL do Google Apps Script
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzYkjZLw--OJpp_vS_f_c9KWVWdyAWyJJ9XFjsEHfAoLHD_OsgVmLphbxC6KvVqjR8OOA/exec";

// Chaves do LocalStorage
const STORAGE_TOKEN_KEY = "compras_session_token";
const STORAGE_USER_KEY = "compras_session_user";
const STORAGE_DRAFT_KEY = "compras_active_editor_draft";

// Categorias padrão do sistema (compartilhadas e imutáveis)
const DEFAULT_CATEGORIES = [
  { id: "cat_1", name: "Hortifrúti", color: "#dcfce7", isSystem: true },
  { id: "cat_2", name: "Padaria", color: "#fef3c7", isSystem: true },
  { id: "cat_3", name: "Carnes", color: "#fee2e2", isSystem: true },
  { id: "cat_4", name: "Laticínios", color: "#e0f2fe", isSystem: true },
  { id: "cat_5", name: "Limpeza", color: "#f3e8ff", isSystem: true },
  { id: "cat_6", name: "Geral", color: "#f1f5f9", isSystem: true }
];

function normalizeCategoryName(name) {
  return String(name || "").trim().toLowerCase();
}

function isSystemCategory(catOrName) {
  if (catOrName && typeof catOrName === "object" && catOrName.isSystem === true) {
    return true;
  }
  const rawName = (catOrName && typeof catOrName === "object") ? catOrName.name : catOrName;
  const norm = normalizeCategoryName(rawName);
  return DEFAULT_CATEGORIES.some(c => normalizeCategoryName(c.name) === norm);
}

function normalizeCategories(categoriesList) {
  const seenNames = new Set();
  const result = DEFAULT_CATEGORIES.map(sysCat => {
    seenNames.add(normalizeCategoryName(sysCat.name));
    return { ...sysCat, isSystem: true };
  });

  if (Array.isArray(categoriesList)) {
    categoriesList.forEach(cat => {
      if (!cat || !cat.name) return;
      const cleanName = String(cat.name).trim();
      const norm = normalizeCategoryName(cleanName);
      if (!norm || seenNames.has(norm)) return;

      seenNames.add(norm);
      result.push({
        id: String(cat.id || ("cat_" + Date.now())),
        name: cleanName,
        color: cat.color || "#f1f5f9",
        isSystem: false
      });
    });
  }

  return result;
}

// Estado da Aplicação
let state = {
  authMode: "login",
  token: localStorage.getItem(STORAGE_TOKEN_KEY) || null,
  currentUser: JSON.parse(localStorage.getItem(STORAGE_USER_KEY) || "null"),
  lists: [],
  catalog: [],
  categories: [...DEFAULT_CATEGORIES],
  currentList: null,
  activeFilter: "ALL"
};

let currentFocusIndex = -1;
let deferredPrompt = null;
let pendingSyncCount = 0;
let editingCategoryId = null;

function getUserCacheKey() {
  const uid = state.currentUser && state.currentUser.id ? state.currentUser.id : null;
  return uid ? `compras_userdata_${uid}` : null;
}

function saveLocalCache() {
  const key = getUserCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      lists: state.lists,
      catalog: state.catalog,
      categories: state.categories,
      updatedAt: Date.now()
    }));
  } catch (e) {
    console.warn("Não foi possível salvar cache local:", e);
  }
}

function loadLocalCache() {
  const key = getUserCacheKey();
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    state.lists = Array.isArray(parsed.lists) ? parsed.lists : [];
    state.catalog = Array.isArray(parsed.catalog) ? parsed.catalog : [];
    state.categories = normalizeCategories(parsed.categories);
    return true;
  } catch (e) {
    return false;
  }
}

function updateSyncBadge(status) {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;
  badge.classList.remove('d-none');

  if (pendingSyncCount > 0 || status === 'syncing') {
    badge.innerHTML = `<span class="spinner-border spinner-border-sm text-primary me-1" style="width: 0.65rem; height: 0.65rem; border-width: 0.12em;"></span>Sincronizando...`;
  } else if (status === 'error') {
    badge.innerHTML = `<i class="bi bi-cloud-slash text-warning-emphasis me-1"></i>Salvo no aparelho`;
  } else {
    badge.innerHTML = `<i class="bi bi-cloud-check text-success me-1"></i>Sincronizado`;
  }
}

// PWA Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}

// Banner PWA
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('installBanner');
  if (banner) {
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
  }
});

function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
      dismissInstallBanner();
    });
  }
}

function dismissInstallBanner() {
  const banner = document.getElementById('installBanner');
  if (banner) {
    banner.classList.add('d-none');
    banner.classList.remove('d-flex');
  }
}

// Requisições seguras compatíveis com origin local (suporta modo bloqueante e modo silencioso/assíncrono)
async function apiCall(action, payload = {}, options = {}) {
  const isSilent = !!options.silent;
  const overlay = document.getElementById('loadingOverlay');

  if (isSilent) {
    pendingSyncCount++;
    updateSyncBadge('syncing');
  } else if (overlay) {
    overlay.style.display = 'flex';
  }

  try {
    const formBody = new URLSearchParams();
    formBody.append("action", action);
    if (state.token) formBody.append("token", state.token);
    for (const key in payload) {
      if (typeof payload[key] === "object") {
        formBody.append(key, JSON.stringify(payload[key]));
      } else {
        formBody.append(key, payload[key]);
      }
    }

    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      body: formBody,
      redirect: 'follow'
    });

    const data = await res.json();

    if (data && data.error && data.error.includes("não autorizado")) {
      logout();
      alert("Sessão expirada ou não autorizada. Faça login novamente.");
      return null;
    }

    if (isSilent) {
      pendingSyncCount = Math.max(0, pendingSyncCount - 1);
      updateSyncBadge(data && data.ok === false ? 'error' : 'synced');
    }

    return data;
  } catch (err) {
    console.error("Erro na requisição:", err);
    if (isSilent) {
      pendingSyncCount = Math.max(0, pendingSyncCount - 1);
      updateSyncBadge('error');
    } else {
      alert("Falha de conexão com o Google Apps Script.\nCertifique-se de que a nova versão do código foi implantada no Apps Script com acesso para 'Qualquer pessoa'.");
    }
    return null;
  } finally {
    if (!isSilent && overlay) {
      overlay.style.display = 'none';
    }
  }
}

// ==========================================
// AUTO-SAVE E PERSISTÊNCIA DE RASCUNHO (DRAFT)
// ==========================================
function saveDraftToStorage() {
  if (state.currentList && (state.currentList.items.length > 0 || state.currentList.date)) {
    localStorage.setItem(STORAGE_DRAFT_KEY, JSON.stringify(state.currentList));
  }
}

function clearDraftStorage() {
  localStorage.removeItem(STORAGE_DRAFT_KEY);
  checkDraftAlert();
}

function checkDraftAlert() {
  const draftStr = localStorage.getItem(STORAGE_DRAFT_KEY);
  const alertEl = document.getElementById('draftAlert');
  if (draftStr && (!state.currentList || document.getElementById('viewHome').classList.contains('active'))) {
    try {
      const draft = JSON.parse(draftStr);
      if (draft && draft.items && (draft.items.length > 0 || draft.date)) {
        document.getElementById('draftAlertDesc').innerText = `Lista de ${draft.date || 'data não informada'} com ${draft.items.length} itens.`;
        alertEl.classList.remove('d-none');
        alertEl.classList.add('d-flex');
        return;
      }
    } catch(e) {}
  }
  if (alertEl) {
    alertEl.classList.add('d-none');
    alertEl.classList.remove('d-flex');
  }
}

function resumeDraft() {
  const draftStr = localStorage.getItem(STORAGE_DRAFT_KEY);
  if (!draftStr) return;
  try {
    state.currentList = JSON.parse(draftStr);
    openEditor();
  } catch(e) {}
}

function discardDraft() {
  clearDraftStorage();
}

function leaveEditorSafely() {
  saveDraftToStorage();
  renderHome();
}

// Salva rascunho automaticamente se a janela/aba for fechada ou ocultada
window.addEventListener('beforeunload', () => {
  if (document.getElementById('viewEditor').classList.contains('active')) {
    saveDraftToStorage();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && document.getElementById('viewEditor').classList.contains('active')) {
    saveDraftToStorage();
  }
});

// ==========================================
// AUTENTICAÇÃO E CONTAS
// ==========================================
function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";

  if (btnEl) {
    const icon = btnEl.querySelector('i');
    if (icon) {
      icon.className = isPassword ? "bi bi-eye-slash" : "bi bi-eye";
    }
  }
}

function resetPasswordInputMask(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = "password";
  const group = input.closest('.input-group');
  if (group) {
    const icon = group.querySelector('button i');
    if (icon) icon.className = "bi bi-eye";
  }
}

function validateAuthPasswordsLive() {
  const feedback = document.getElementById('authPasswordFeedback');
  if (!feedback) return;

  if (state.authMode !== "register") {
    feedback.classList.add('d-none');
    return;
  }

  const pass = document.getElementById('authPassword').value;
  const confirmPass = document.getElementById('authConfirmPassword').value;

  if (!confirmPass) {
    feedback.classList.add('d-none');
    return;
  }

  feedback.classList.remove('d-none', 'text-success', 'text-danger');
  if (pass === confirmPass) {
    feedback.classList.add('text-success');
    feedback.innerHTML = `<i class="bi bi-check-circle-fill me-1"></i>As senhas coincidem.`;
  } else {
    feedback.classList.add('text-danger');
    feedback.innerHTML = `<i class="bi bi-exclamation-circle-fill me-1"></i>As senhas não coincidem.`;
  }
}

function toggleAuthMode() {
  state.authMode = state.authMode === "login" ? "register" : "login";
  const isReg = state.authMode === "register";

  document.getElementById('authTitle').innerText = isReg ? "Criar Nova Conta" : "Acessar Lista de Compras";
  document.getElementById('authSubtitle').innerText = isReg ? "Crie sua conta para manter suas listas salvas com segurança." : "Entre com suas credenciais para visualizar e alterar os dados.";
  document.getElementById('authSubmitBtn').innerText = isReg ? "Cadastrar" : "Entrar";
  document.getElementById('nameFieldGroup').style.display = isReg ? "block" : "none";
  document.getElementById('confirmPasswordGroup').style.display = isReg ? "block" : "none";
  document.getElementById('authConfirmPassword').required = isReg;
  document.getElementById('authConfirmPassword').value = "";
  document.getElementById('toggleAuthModeBtn').innerText = isReg ? "Já tem conta? Fazer login" : "Não tem conta? Criar nova conta";

  resetPasswordInputMask('authPassword');
  resetPasswordInputMask('authConfirmPassword');
  validateAuthPasswordsLive();
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirmPassword = document.getElementById('authConfirmPassword').value;
  const name = document.getElementById('authName').value.trim();

  if (state.authMode === "login") {
    const res = await apiCall("login", { email, password });
    if (res && res.ok) {
      setSession(res.token, res.user);
      await enterApp();
    } else {
      alert((res && res.error) || "Falha no login. Verifique suas credenciais.");
    }
  } else {
    if (password.length < 4) {
      alert("A senha deve ter pelo menos 4 caracteres.");
      document.getElementById('authPassword').focus();
      return;
    }
    if (password !== confirmPassword) {
      alert("A confirmação de senha não confere. Digite a mesma senha nos dois campos.");
      document.getElementById('authConfirmPassword').focus();
      return;
    }

    const res = await apiCall("register", { email, password, name });
    if (res && res.ok) {
      alert("Conta criada com sucesso!");
      setSession(res.token, res.user);
      await enterApp();
    } else {
      alert((res && res.error) || "Falha ao criar conta.");
    }
  }
}

function setSession(token, user) {
  state.token = token;
  state.currentUser = user;
  localStorage.setItem(STORAGE_TOKEN_KEY, token);
  localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
  updateUserBadge();
}

function updateUserBadge() {
  const badge = document.getElementById('userBadge');
  if (badge) {
    badge.innerText = `Logado como: ${state.currentUser ? (state.currentUser.name || state.currentUser.email) : ''}`;
  }
}

function logout() {
  state.token = null;
  state.currentUser = null;
  state.lists = [];
  state.catalog = [];
  state.categories = normalizeCategories([]);
  state.currentList = null;
  editingCategoryId = null;
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_USER_KEY);
  document.getElementById('mainAppArea').style.display = 'none';
  switchView('viewAuth');
}

async function enterApp() {
  document.getElementById('mainAppArea').style.display = 'block';
  updateUserBadge();

  // Local-First: se já houver cache local do usuário, abre a tela imediatamente e sincroniza em background
  const hasCache = loadLocalCache();
  if (hasCache) {
    renderHome();
    syncDataFromBackend({ silent: true });
  } else {
    await syncDataFromBackend({ silent: false });
    renderHome();
  }
}

async function syncDataFromBackend(options = { silent: true }) {
  if (!state.token) return;
  const data = await apiCall("getData", {}, options);
  if (data && data.ok) {
    state.lists = data.lists || [];
    state.catalog = data.catalog || [];
    state.categories = normalizeCategories(data.categories);
    saveLocalCache();

    // Se o usuário estiver na Home, atualiza a listagem silenciosamente
    if (document.getElementById('viewHome').classList.contains('active')) {
      renderHome();
    } else if (document.getElementById('viewCategories').classList.contains('active') && !editingCategoryId) {
      renderCategoriesList();
    }
  }
}

async function init() {
  if (state.token && state.currentUser) {
    await enterApp();
  } else {
    switchView('viewAuth');
  }
}

function switchView(viewId) {
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

function getCategoryColor(name) {
  const cat = state.categories.find(c => c.name.toLowerCase() === (name || "").toLowerCase());
  return cat ? cat.color : "#f1f5f9";
}

function getTodayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ===============================================
// TELA 1: HOME & HISTÓRICO
// ===============================================
function renderHome() {
  switchView('viewHome');
  document.getElementById('pageTitle').innerText = "Minhas Listas";
  checkDraftAlert();
  const container = document.getElementById('listsContainer');
  container.innerHTML = "";

  if (!state.lists.length) {
    container.innerHTML = `
      <div class="card border-0 shadow-sm text-center py-5 text-muted">
        <i class="bi bi-basket3 display-4 mb-3 text-secondary"></i>
        <p class="mb-0">Nenhuma lista encontrada. Comece criando uma nova lista!</p>
      </div>`;
    return;
  }

  const sorted = [...state.lists].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  sorted.forEach(l => {
    const isCompleted = l.status === "concluida";
    const itemCount = l.items ? l.items.length : 0;
    const checkedCount = l.items ? l.items.filter(i => i.checked).length : 0;
    const displayTitle = l.date || l.name || "Sem data";

    const card = document.createElement('div');
    card.className = "card border-0 shadow-sm mb-3";
    card.innerHTML = `
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div>
            <h5 class="card-title fw-bold mb-1 font-monospace">${displayTitle}</h5>
            <div class="text-muted small">
              <i class="bi bi-calendar-event"></i> Data da Compra: ${l.date || "Não informada"} &bull; 
              <i class="bi bi-bag"></i> ${itemCount} itens ${!isCompleted && itemCount > 0 ? `(${checkedCount} no carrinho)` : ''}
            </div>
          </div>
          <span class="badge ${isCompleted ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning-emphasis'} fs-7">
            ${isCompleted ? '<i class="bi bi-check-all"></i> Concluída' : '<i class="bi bi-hourglass-split"></i> Em Andamento'}
          </span>
        </div>

        <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top">
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" onclick="cloneList('${l.id}')">
              <i class="bi bi-copy"></i> Copiar Base
            </button>
            ${!isCompleted ? `
              <button class="btn btn-sm btn-primary d-flex align-items-center gap-1" onclick="resumeShopping('${l.id}')">
                <i class="bi bi-cart3"></i> Ir às Compras
              </button>
            ` : ''}
            <button class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1" onclick="editList('${l.id}')">
              <i class="bi bi-pencil"></i> Editar
            </button>
          </div>
          <button class="btn btn-sm btn-outline-danger d-flex align-items-center gap-1" title="Excluir Lista" onclick="deleteList('${l.id}', '${escapeHtml(displayTitle)}')">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

async function deleteList(listId, displayTitle) {
  if (!confirm(`Tem certeza de que deseja excluir permanentemente a lista "${displayTitle}"?`)) return;

  // Local-First: remove imediatamente na UI e no cache local, sincronizando em background
  state.lists = state.lists.filter(l => l.id !== listId);
  saveLocalCache();
  renderHome();

  apiCall("deleteList", { listId: listId }, { silent: true });
}

// ========================================================
// TELA 2: EDIÇÃO DE LISTA
// ========================================================
function startNewList() {
  const defaultDate = getTodayIsoDate();
  state.currentList = {
    id: "list_" + Date.now(),
    date: defaultDate,
    name: defaultDate,
    status: "comprando",
    items: []
  };
  saveDraftToStorage();
  openEditor();
}

function cloneList(sourceId) {
  const src = state.lists.find(x => x.id === sourceId);
  if (!src) return;
  const today = getTodayIsoDate();
  state.currentList = {
    id: "list_" + Date.now(),
    date: today,
    name: today,
    status: "comprando",
    items: src.items.map(it => ({
      ...it,
      id: "item_" + Math.random().toString(36).substr(2, 9),
      checked: false
    }))
  };
  saveDraftToStorage();
  openEditor();
}

function editList(listId) {
  const src = state.lists.find(x => x.id === listId);
  if (!src) return;
  state.currentList = JSON.parse(JSON.stringify(src));
  saveDraftToStorage();
  openEditor();
}

function updateTitleFromDate(dateValue) {
  const finalDate = dateValue || getTodayIsoDate();
  state.currentList.date = finalDate;
  state.currentList.name = finalDate;
  document.getElementById('generatedTitlePreview').innerText = finalDate;
  document.getElementById('pageTitle').innerText = finalDate;
  saveDraftToStorage();
}

function openEditor() {
  switchView('viewEditor');
  const listDate = state.currentList.date || getTodayIsoDate();
  document.getElementById('listDate').value = listDate;
  updateTitleFromDate(listDate);
  renderCategorySelect();
  renderEditorItems();
  hideAutocomplete();
}

function renderCategorySelect() {
  const sel = document.getElementById('itemCategory');
  const systemCats = state.categories.filter(c => isSystemCategory(c));
  const customCats = state.categories.filter(c => !isSystemCategory(c));

  let html = `<optgroup label="Padrão do Sistema">`;
  html += systemCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  html += `</optgroup>`;

  if (customCats.length > 0) {
    html += `<optgroup label="Minhas Categorias">`;
    html += customCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    html += `</optgroup>`;
  }

  html += `<option value="__NEW__">+ Criar nova categoria/ala...</option>`;
  sel.innerHTML = html;
}

function checkCategorySelect(val) {
  const box = document.getElementById('inlineCatBox');
  box.style.display = (val === "__NEW__") ? "block" : "none";
  if (val === "__NEW__") {
    document.getElementById('inlineCatName').focus();
  }
}

function cancelInlineCategory() {
  document.getElementById('inlineCatBox').style.display = "none";
  document.getElementById('inlineCatName').value = "";
  const sel = document.getElementById('itemCategory');
  if (sel && state.categories.length > 0) {
    sel.value = state.categories[0].name;
  }
}

async function persistUserCategories(renames = null) {
  saveLocalCache();
  const customOnly = state.categories.filter(c => !isSystemCategory(c));
  const payload = { categories: customOnly };
  if (renames) payload.renames = renames;
  const res = await apiCall("saveCategories", payload, { silent: true });
  if (res && res.ok && Array.isArray(res.categories)) {
    state.categories = normalizeCategories(res.categories);
    saveLocalCache();
  }
}

async function confirmInlineCategory() {
  const name = document.getElementById('inlineCatName').value.trim();
  const color = document.getElementById('inlineCatColor').value;
  if (!name) return alert("Digite o nome da categoria.");

  const existing = state.categories.find(c => normalizeCategoryName(c.name) === normalizeCategoryName(name));
  if (existing) {
    alert(`A categoria "${existing.name}" já existe e foi selecionada.`);
    renderCategorySelect();
    document.getElementById('itemCategory').value = existing.name;
    document.getElementById('inlineCatBox').style.display = "none";
    document.getElementById('inlineCatName').value = "";
    return;
  }

  const newCat = { id: "cat_" + Date.now(), name, color, isSystem: false };
  state.categories.push(newCat);

  renderCategorySelect();
  document.getElementById('itemCategory').value = name;
  document.getElementById('inlineCatBox').style.display = "none";
  document.getElementById('inlineCatName').value = "";
  saveDraftToStorage();

  persistUserCategories();
}

// ==========================================
// AUTOCOMPLETE CLIENT-SIDE
// ==========================================
function onItemInput(val) {
  const dropdown = document.getElementById('autocompleteDropdown');
  const term = (val || "").trim().toLowerCase();
  currentFocusIndex = -1;

  if (!term) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  const matches = state.catalog.filter(item => 
    item.name && item.name.toLowerCase().includes(term)
  ).slice(0, 7);

  if (!matches.length) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  let html = '';
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedTerm})`, 'gi');
  matches.forEach(item => {
    const catColor = getCategoryColor(item.category);
    const highlightedName = item.name.replace(regex, '<strong>$1</strong>');

    html += `
      <div class="autocomplete-item" onclick="selectAutocompleteItem('${escapeHtml(item.name)}', '${escapeHtml(item.category)}')">
        <div class="d-flex align-items-center gap-2">
          <i class="bi bi-clock-history text-muted small"></i>
          <span>${highlightedName}</span>
        </div>
        <span class="badge border text-dark" style="background-color: ${catColor}; font-size: 0.75rem;">
          ${item.category || 'Geral'}
        </span>
      </div>
    `;
  });

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
}

function selectAutocompleteItem(name, category) {
  document.getElementById('itemName').value = name;
  if (category) {
    const sel = document.getElementById('itemCategory');
    if ([...sel.options].some(o => o.value === category)) {
      sel.value = category;
    }
  }
  hideAutocomplete();
  document.getElementById('itemQty').focus();
}

function hideAutocomplete() {
  const dropdown = document.getElementById('autocompleteDropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }
  currentFocusIndex = -1;
}

function handleAutocompleteKeydown(e) {
  const dropdown = document.getElementById('autocompleteDropdown');
  const items = dropdown.getElementsByClassName('autocomplete-item');
  if (!items.length || dropdown.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    currentFocusIndex++;
    if (currentFocusIndex >= items.length) currentFocusIndex = 0;
    highlightAutocompleteItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    currentFocusIndex--;
    if (currentFocusIndex < 0) currentFocusIndex = items.length - 1;
    highlightAutocompleteItem(items);
  } else if (e.key === 'Enter') {
    if (currentFocusIndex > -1 && items[currentFocusIndex]) {
      e.preventDefault();
      items[currentFocusIndex].click();
    }
  } else if (e.key === 'Escape') {
    hideAutocomplete();
  }
}

function highlightAutocompleteItem(items) {
  for (let i = 0; i < items.length; i++) {
    items[i].classList.remove('active');
  }
  if (currentFocusIndex > -1 && items[currentFocusIndex]) {
    items[currentFocusIndex].classList.add('active');
    items[currentFocusIndex].scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('click', function (e) {
  if (!e.target.closest('.autocomplete-wrapper')) {
    hideAutocomplete();
  }
});

function escapeHtml(text) {
  return String(text || '')
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function addItemToList() {
  const name = document.getElementById('itemName').value.trim();
  const qty = parseInt(document.getElementById('itemQty').value) || 1;
  const cat = document.getElementById('itemCategory').value;

  if (!name) return alert("Informe o nome do item.");
  if (cat === "__NEW__") return alert("Finalize a criação da categoria.");

  state.currentList.items.push({
    id: "item_" + Math.random().toString(36).substr(2, 9),
    name,
    category: cat,
    quantity: qty,
    checked: false
  });

  const existsInCatalog = state.catalog.some(c => c.name.toLowerCase() === name.toLowerCase());
  if (!existsInCatalog) {
    state.catalog.push({ id: "cat_item_" + Date.now(), name, category: cat });
    saveLocalCache();
  }

  document.getElementById('itemName').value = "";
  document.getElementById('itemQty').value = "1";
  hideAutocomplete();
  renderEditorItems();
  saveDraftToStorage();
}

function removeItemFromList(itemId) {
  state.currentList.items = state.currentList.items.filter(item => item.id !== itemId);
  renderEditorItems();
  saveDraftToStorage();
}

function renderEditorItems() {
  const container = document.getElementById('editorItemsContainer');
  container.innerHTML = "";

  if (!state.currentList.items.length) {
    container.innerHTML = `<div class="text-center text-muted small py-3">Nenhum item adicionado ainda.</div>`;
    return;
  }

  const items = [...state.currentList.items].sort((a, b) => a.category.localeCompare(b.category));

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = "card border-0 mb-2 shadow-sm";
    card.style.backgroundColor = getCategoryColor(item.category);
    card.innerHTML = `
      <div class="card-body p-2 d-flex justify-content-between align-items-center">
        <div>
          <strong class="text-dark">${item.name}</strong>
          <span class="badge bg-light text-dark ms-2 border">${item.category}</span>
        </div>
        <div class="d-flex align-items-center gap-3">
          <span class="fw-bold text-dark">x${item.quantity}</span>
          <button class="btn btn-sm btn-link text-danger p-0" onclick="removeItemFromList('${escapeHtml(item.id)}')">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function saveAndEnterShoppingMode() {
  const dateInput = document.getElementById('listDate').value || getTodayIsoDate();
  state.currentList.date = dateInput;
  state.currentList.name = dateInput;

  const isExisting = state.lists.some(l => l.id === state.currentList.id);
  const action = isExisting ? "updateList" : "saveList";

  // Local-First: atualiza o estado e o cache do navegador imediatamente
  const idx = state.lists.findIndex(l => l.id === state.currentList.id);
  const listSnapshot = JSON.parse(JSON.stringify(state.currentList));
  if (idx >= 0) state.lists[idx] = listSnapshot;
  else state.lists.push(listSnapshot);

  saveLocalCache();
  clearDraftStorage();
  openShoppingMode(state.currentList);

  // Sincroniza em segundo plano sem travar a interface
  apiCall(action, { list: listSnapshot }, { silent: true });
}

// =======================
// TELA 3: MODO DE COMPRAS
// =======================
function resumeShopping(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (list) openShoppingMode(list);
}

function openShoppingMode(list) {
  state.currentList = list;
  state.activeFilter = "ALL";
  switchView('viewShopping');
  document.getElementById('pageTitle').innerText = list.date || list.name;
  renderFilterChips();
  renderShoppingItems();
}

function renderFilterChips() {
  const container = document.getElementById('shoppingFiltersContainer');
  const catsInList = Array.from(new Set(state.currentList.items.map(i => i.category)));

  let html = `
    <span class="badge filter-badge ${state.activeFilter === 'ALL' ? 'bg-dark text-white' : 'bg-white text-dark border'}" onclick="setShoppingFilter('ALL')">
      Todas (${state.currentList.items.length})
    </span>
  `;

  catsInList.forEach(c => {
    const count = state.currentList.items.filter(i => i.category === c).length;
    const isCurrent = state.activeFilter === c;
    html += `
      <span class="badge filter-badge ${isCurrent ? 'bg-dark text-white' : 'bg-white text-dark border'}" onclick="setShoppingFilter('${c}')">
        ${c} (${count})
      </span>
    `;
  });

  container.innerHTML = html;
}

function setShoppingFilter(cat) {
  state.activeFilter = cat;
  renderFilterChips();
  renderShoppingItems();
}

function renderShoppingItems() {
  const container = document.getElementById('shoppingItemsContainer');
  container.innerHTML = "";

  let items = [...state.currentList.items];
  if (state.activeFilter !== "ALL") {
    items = items.filter(i => i.category === state.activeFilter);
  }

  items.sort((a, b) => a.category.localeCompare(b.category));

  if (!items.length) {
    container.innerHTML = `<div class="text-center text-muted py-4">Nenhum item nesta ala.</div>`;
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = `card border-0 mb-2 shadow-sm shopping-item-card ${item.checked ? 'checked' : ''}`;
    card.style.backgroundColor = getCategoryColor(item.category);
    card.onclick = () => toggleShoppingItem(item.id);

    card.innerHTML = `
      <div class="card-body p-3 d-flex justify-content-between align-items-center">
        <div class="d-flex align-items-center gap-3">
          <input class="form-check-input mt-0 fs-5" type="checkbox" ${item.checked ? 'checked' : ''} style="pointer-events: none;">
          <div>
            <div class="fw-bold text-dark fs-6">${item.name}</div>
            <span class="badge bg-white text-dark border">${item.category}</span>
          </div>
        </div>
        <span class="badge bg-dark fs-6 px-3 py-2">x${item.quantity}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function toggleShoppingItem(id) {
  const it = state.currentList.items.find(i => i.id === id);
  if (it) {
    it.checked = !it.checked;
    const idx = state.lists.findIndex(l => l.id === state.currentList.id);
    if (idx >= 0) state.lists[idx] = state.currentList;
    saveLocalCache();
    renderShoppingItems();
  }
}

function exitShoppingMode() {
  const listSnapshot = JSON.parse(JSON.stringify(state.currentList));
  const idx = state.lists.findIndex(l => l.id === listSnapshot.id);
  if (idx >= 0) state.lists[idx] = listSnapshot;
  saveLocalCache();
  renderHome();

  apiCall("updateList", { list: listSnapshot }, { silent: true });
}

function finishShopping() {
  if (!confirm("Deseja marcar esta lista como compra concluída?")) return;
  state.currentList.status = "concluida";
  state.currentList.completedAt = new Date().toISOString();

  const listSnapshot = JSON.parse(JSON.stringify(state.currentList));
  const idx = state.lists.findIndex(l => l.id === listSnapshot.id);
  if (idx >= 0) state.lists[idx] = listSnapshot;
  saveLocalCache();
  renderHome();

  apiCall("updateList", { list: listSnapshot }, { silent: true });
}

// ========================================================
// TELA 4: CONFIGURAÇÕES (PERFIL, SENHA E CATEGORIAS)
// ========================================================
function openSettingsView(focusSection = null) {
  editingCategoryId = null;
  switchView('viewCategories');
  document.getElementById('pageTitle').innerText = "Configurações";

  // Preenche dados do perfil
  const emailEl = document.getElementById('settingsEmailDisplay');
  const nameEl = document.getElementById('settingsNameInput');
  if (emailEl) emailEl.value = (state.currentUser && state.currentUser.email) || "";
  if (nameEl) nameEl.value = (state.currentUser && state.currentUser.name) || "";

  // Limpa formulários e feedbacks de senha/perfil
  const profFb = document.getElementById('profileFeedback');
  if (profFb) profFb.classList.add('d-none');

  const passForm = document.getElementById('changePasswordForm');
  if (passForm) passForm.reset();
  resetPasswordInputMask('settingsCurrentPassword');
  resetPasswordInputMask('settingsNewPassword');
  resetPasswordInputMask('settingsConfirmPassword');
  const passFb = document.getElementById('passwordChangeFeedback');
  if (passFb) passFb.classList.add('d-none');

  renderCategoriesList();

  if (focusSection === 'categories') {
    const sec = document.getElementById('settingsCategoriesSection');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function openCategoriesView() {
  openSettingsView('categories');
}

function showInlineFeedback(elId, message, isSuccess) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('d-none', 'text-success', 'text-danger');
  el.classList.add(isSuccess ? 'text-success' : 'text-danger');
  el.innerHTML = `<i class="bi ${isSuccess ? 'bi-check-circle-fill' : 'bi-exclamation-circle-fill'} me-1"></i>${escapeHtml(message)}`;
}

async function handleUpdateProfile(e) {
  e.preventDefault();
  const nameInput = document.getElementById('settingsNameInput');
  const newName = (nameInput ? nameInput.value : "").trim();
  if (!newName) {
    showInlineFeedback('profileFeedback', 'O nome de tela não pode ficar vazio.', false);
    return;
  }

  // Atualiza localmente na hora (Optimistic UI)
  if (state.currentUser) {
    state.currentUser.name = newName;
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(state.currentUser));
    updateUserBadge();
  }
  showInlineFeedback('profileFeedback', 'Nome atualizado com sucesso!', true);

  const res = await apiCall("updateProfile", { name: newName }, { silent: true });
  if (res && res.ok && res.user) {
    setSession(res.token || state.token, res.user);
  } else if (res && res.error) {
    showInlineFeedback('profileFeedback', res.error, false);
  }
}

function validateSettingsPasswordsLive() {
  const newPass = document.getElementById('settingsNewPassword').value;
  const confirmPass = document.getElementById('settingsConfirmPassword').value;
  const fb = document.getElementById('passwordChangeFeedback');
  if (!fb) return;

  if (!confirmPass) {
    fb.classList.add('d-none');
    return;
  }

  if (newPass === confirmPass) {
    showInlineFeedback('passwordChangeFeedback', 'A confirmação da nova senha confere.', true);
  } else {
    showInlineFeedback('passwordChangeFeedback', 'As senhas digitadas não coincidem.', false);
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('settingsCurrentPassword').value;
  const newPassword = document.getElementById('settingsNewPassword').value;
  const confirmPassword = document.getElementById('settingsConfirmPassword').value;

  if (newPassword.length < 4) {
    showInlineFeedback('passwordChangeFeedback', 'A nova senha deve ter pelo menos 4 caracteres.', false);
    return;
  }
  if (newPassword !== confirmPassword) {
    showInlineFeedback('passwordChangeFeedback', 'A confirmação da nova senha não confere.', false);
    return;
  }

  const btn = document.getElementById('changePasswordBtn');
  if (btn) btn.disabled = true;

  const res = await apiCall("changePassword", { currentPassword, newPassword });
  if (btn) btn.disabled = false;

  if (res && res.ok) {
    document.getElementById('changePasswordForm').reset();
    resetPasswordInputMask('settingsCurrentPassword');
    resetPasswordInputMask('settingsNewPassword');
    resetPasswordInputMask('settingsConfirmPassword');
    showInlineFeedback('passwordChangeFeedback', res.message || 'Senha alterada com sucesso!', true);
  } else {
    showInlineFeedback('passwordChangeFeedback', (res && res.error) || 'Não foi possível alterar a senha.', false);
  }
}

function renderCategoriesList() {
  const container = document.getElementById('categoriesListContainer');
  container.innerHTML = "";

  const customCategories = state.categories.filter(cat => !isSystemCategory(cat));
  const systemCategories = state.categories.filter(cat => isSystemCategory(cat));

  // Seção 1: Categorias personalizadas do usuário
  const customHeader = document.createElement('div');
  customHeader.className = "small fw-semibold text-secondary mb-2";
  customHeader.innerHTML = `<i class="bi bi-person-lock me-1"></i>Minhas Categorias (${customCategories.length})`;
  container.appendChild(customHeader);

  if (customCategories.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = "text-muted small fst-italic p-2 mb-3 bg-light rounded border";
    emptyMsg.innerText = "Você ainda não criou categorias personalizadas.";
    container.appendChild(emptyMsg);
  } else {
    customCategories.forEach(cat => {
      const item = document.createElement('div');
      item.className = "d-flex justify-content-between align-items-center p-2 rounded mb-2 border gap-2";
      item.style.backgroundColor = cat.color;

      if (editingCategoryId === cat.id) {
        item.innerHTML = `
          <div class="d-flex align-items-center gap-2 flex-grow-1">
            <input type="text" id="editCatName_${escapeHtml(cat.id)}" class="form-control form-control-sm" value="${escapeHtml(cat.name)}" onkeydown="if(event.key==='Enter'){event.preventDefault();saveEditedCategory('${escapeHtml(cat.id)}');}else if(event.key==='Escape'){cancelEditCategory();}">
            <input type="color" id="editCatColor_${escapeHtml(cat.id)}" class="form-control form-control-color form-control-sm" value="${escapeHtml(cat.color)}" title="Mudar cor">
          </div>
          <div class="d-flex gap-1 align-items-center">
            <button class="btn btn-sm btn-success" title="Salvar alterações" onclick="saveEditedCategory('${escapeHtml(cat.id)}')">
              <i class="bi bi-check-lg"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary bg-white" title="Cancelar edição" onclick="cancelEditCategory()">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
        `;
      } else {
        item.innerHTML = `
          <div class="d-flex align-items-center gap-2">
            <span class="fw-bold text-dark">${escapeHtml(cat.name)}</span>
            <span class="badge bg-white text-secondary border" style="font-size: 0.7rem;">Pessoal</span>
          </div>
          <div class="d-flex gap-1 align-items-center">
            <input type="color" class="form-control form-control-color form-control-sm" value="${escapeHtml(cat.color)}" onchange="updateCatColor('${escapeHtml(cat.id)}', this.value)" title="Mudar cor">
            <button class="btn btn-sm btn-outline-primary bg-white" title="Editar nome da categoria" onclick="startEditCategory('${escapeHtml(cat.id)}')">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger bg-white" title="Excluir categoria" onclick="deleteCategory('${escapeHtml(cat.id)}')">
              <i class="bi bi-trash3"></i>
            </button>
          </div>
        `;
      }
      container.appendChild(item);
    });
  }

  // Seção 2: Categorias padrão do sistema (somente leitura)
  const sysHeader = document.createElement('div');
  sysHeader.className = "small fw-semibold text-secondary mt-3 mb-2";
  sysHeader.innerHTML = `<i class="bi bi-shield-check me-1"></i>Padrão do Sistema (${systemCategories.length})`;
  container.appendChild(sysHeader);

  systemCategories.forEach(cat => {
    const item = document.createElement('div');
    item.className = "d-flex justify-content-between align-items-center p-2 rounded mb-2 border";
    item.style.backgroundColor = cat.color;
    item.innerHTML = `
      <span class="fw-bold text-dark">${escapeHtml(cat.name)}</span>
      <span class="badge bg-white text-muted border d-flex align-items-center gap-1" style="font-size: 0.72rem;" title="Categoria padrão do sistema">
        <i class="bi bi-lock-fill"></i> Padrão
      </span>
    `;
    container.appendChild(item);
  });
}

function startEditCategory(catId) {
  editingCategoryId = catId;
  renderCategoriesList();
  const input = document.getElementById(`editCatName_${catId}`);
  if (input) {
    input.focus();
    input.select();
  }
}

function cancelEditCategory() {
  editingCategoryId = null;
  renderCategoriesList();
}

function saveEditedCategory(catId) {
  const target = state.categories.find(c => c.id === catId && !isSystemCategory(c));
  if (!target) return;

  const nameInput = document.getElementById(`editCatName_${catId}`);
  const colorInput = document.getElementById(`editCatColor_${catId}`);
  const newName = (nameInput ? nameInput.value : "").trim();
  const newColor = colorInput ? colorInput.value : target.color;

  if (!newName) return alert("O nome da categoria não pode ficar vazio.");

  const duplicate = state.categories.find(c => c.id !== catId && normalizeCategoryName(c.name) === normalizeCategoryName(newName));
  if (duplicate) return alert("Já existe outra categoria com este nome.");

  const oldName = target.name;
  target.name = newName;
  target.color = newColor;
  editingCategoryId = null;

  let renames = null;
  if (oldName !== newName) {
    renames = { [oldName]: newName };
    // Atualiza referências locais nas listas e no catálogo
    state.lists.forEach(list => {
      (list.items || []).forEach(it => {
        if (it.category === oldName) it.category = newName;
      });
    });
    if (state.currentList && state.currentList.items) {
      state.currentList.items.forEach(it => {
        if (it.category === oldName) it.category = newName;
      });
    }
    state.catalog.forEach(catItem => {
      if (catItem.category === oldName) catItem.category = newName;
    });
  }

  renderCategoriesList();
  persistUserCategories(renames);
}

function createCategoryFromManager() {
  const inputEl = document.getElementById('manageCatName');
  const name = inputEl.value.trim();
  const color = document.getElementById('manageCatColor').value;
  if (!name) return alert("Informe o nome da categoria.");

  const exists = state.categories.some(c => normalizeCategoryName(c.name) === normalizeCategoryName(name));
  if (exists) return alert("Já existe uma categoria (padrão ou pessoal) com este nome.");

  state.categories.push({ id: "cat_" + Date.now(), name, color, isSystem: false });
  inputEl.value = "";
  renderCategoriesList();
  persistUserCategories();
}

function updateCatColor(catId, color) {
  const target = state.categories.find(c => c.id === catId && !isSystemCategory(c));
  if (!target) return;
  target.color = color;
  renderCategoriesList();
  persistUserCategories();
}

function deleteCategory(catId) {
  const target = state.categories.find(c => c.id === catId);
  if (!target) return;
  if (isSystemCategory(target)) {
    return alert("Categorias padrão do sistema não podem ser excluídas.");
  }
  if (!confirm(`Deseja excluir a categoria personalizada "${target.name}"?`)) return;

  state.categories = state.categories.filter(c => c.id !== catId);
  if (editingCategoryId === catId) editingCategoryId = null;
  renderCategoriesList();
  persistUserCategories();
}

function goHome() {
  renderHome();
}

window.onload = init;
