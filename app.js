// URL do Google Apps Script
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzYkjZLw--OJpp_vS_f_c9KWVWdyAWyJJ9XFjsEHfAoLHD_OsgVmLphbxC6KvVqjR8OOA/exec";

// Categorias padrão caso a planilha esteja completamente vazia
const DEFAULT_CATEGORIES = [
  { id: "cat_1", name: "Hortifrúti", color: "#dcfce7" },
  { id: "cat_2", name: "Padaria", color: "#fef3c7" },
  { id: "cat_3", name: "Carnes", color: "#fee2e2" },
  { id: "cat_4", name: "Laticínios", color: "#e0f2fe" },
  { id: "cat_5", name: "Limpeza", color: "#f3e8ff" },
  { id: "cat_6", name: "Geral", color: "#f1f5f9" }
];

// Estado da Aplicação (Memória em Cache)
let state = {
  lists: [],
  catalog: [],
  categories: [...DEFAULT_CATEGORIES],
  currentList: null,
  activeFilter: "ALL"
};

let currentFocusIndex = -1;

// Requisições com bloqueio de interface
async function apiCall(method, body = null) {
  const overlay = document.getElementById('loadingOverlay');
  overlay.style.display = 'flex';

  try {
    const opts = {
      method: method,
      redirect: 'follow'
    };

    if (body) {
      // Envio em text/plain para contornar pre-flight CORS no Apps Script
      opts.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(SCRIPT_URL, opts);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Erro na requisição:", err);
    alert("Houve uma falha na conexão com a planilha Google. Os dados continuam disponíveis localmente.");
    return null;
  } finally {
    overlay.style.display = 'none';
  }
}

// Sincroniza dados com o backend
async function syncDataFromBackend() {
  const data = await apiCall("GET");
  if (data) {
    state.lists = data.lists || [];
    state.catalog = data.catalog || [];

    // Se o backend tiver categorias cadastradas, atualiza a lista oficial
    if (data.categories && data.categories.length > 0) {
      state.categories = data.categories;
    } else {
      // Se a aba estiver vazia no primeiro uso, salva as categorias padrão na planilha
      await apiCall("POST", { action: "saveCategories", categories: state.categories });
    }
  }
}

// Inicialização: executada ao abrir a aplicação
async function init() {
  await syncDataFromBackend();
  renderHome();
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
  return new Date().toISOString().split('T')[0];
}

// ===============================================
// TELA 1: HOME & HISTÓRICO (Mais novo para mais antigo)
// ===============================================
function renderHome() {
  switchView('viewHome');
  document.getElementById('pageTitle').innerText = "Minhas Listas";
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

  // Ordenação do mais recente para o mais antigo (AAAA-MM-DD)
  const sorted = [...state.lists].sort((a, b) => {
    const dateA = a.date || "";
    const dateB = b.date || "";
    return dateB.localeCompare(dateA);
  });

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

        <div class="d-flex gap-2 mt-3 pt-2 border-top">
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
      </div>
    `;
    container.appendChild(card);
  });
}

// ========================================================
// TELA 2: EDIÇÃO DE LISTA & SINCRONIZAÇÃO DE CATEGORIAS
// ========================================================
async function startNewList() {
  // Atualiza as categorias e catálogo do banco antes de abrir o formulário
  await syncDataFromBackend();

  const defaultDate = getTodayIsoDate();
  state.currentList = {
    id: "list_" + Date.now(),
    date: defaultDate,
    name: defaultDate,
    status: "comprando",
    items: []
  };
  openEditor();
}

async function cloneList(sourceId) {
  await syncDataFromBackend();

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
  openEditor();
}

async function editList(listId) {
  await syncDataFromBackend();

  const src = state.lists.find(x => x.id === listId);
  if (!src) return;
  state.currentList = JSON.parse(JSON.stringify(src));
  openEditor();
}

function updateTitleFromDate(dateValue) {
  const finalDate = dateValue || getTodayIsoDate();
  state.currentList.date = finalDate;
  state.currentList.name = finalDate;
  document.getElementById('generatedTitlePreview').innerText = finalDate;
  document.getElementById('pageTitle').innerText = finalDate;
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
  sel.innerHTML = state.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  sel.innerHTML += `<option value="__NEW__">+ Criar nova categoria/ala...</option>`;
}

function checkCategorySelect(val) {
  const box = document.getElementById('inlineCatBox');
  box.style.display = (val === "__NEW__") ? "block" : "none";
  if (val === "__NEW__") {
    document.getElementById('inlineCatName').focus();
  }
}

// Criação inline com persistência imediata na planilha
async function confirmInlineCategory() {
  const name = document.getElementById('inlineCatName').value.trim();
  const color = document.getElementById('inlineCatColor').value;
  if (!name) return alert("Digite o nome da categoria.");

  const exists = state.categories.some(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    alert("Esta categoria já existe!");
    document.getElementById('itemCategory').value = name;
    document.getElementById('inlineCatBox').style.display = "none";
    return;
  }

  const newCat = { id: "cat_" + Date.now(), name, color };
  state.categories.push(newCat);

  // Persiste imediatamente na planilha para garantir que apareça em "Categorias Cadastradas"
  await apiCall("POST", { action: "saveCategories", categories: state.categories });

  renderCategorySelect();
  document.getElementById('itemCategory').value = name;
  document.getElementById('inlineCatBox').style.display = "none";
  document.getElementById('inlineCatName').value = "";
}

// ==========================================
// AUTOCOMPLETE CLIENT-SIDE (Sem requisições adicionais)
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
  matches.forEach(item => {
    const catColor = getCategoryColor(item.category);
    const regex = new RegExp(`(${term})`, 'gi');
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
  return (text || '').replace(/'/g, "\'");
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
  }

  document.getElementById('itemName').value = "";
  document.getElementById('itemQty').value = "1";
  hideAutocomplete();
  renderEditorItems();
}

function removeItemFromList(idx) {
  state.currentList.items.splice(idx, 1);
  renderEditorItems();
}

function renderEditorItems() {
  const container = document.getElementById('editorItemsContainer');
  container.innerHTML = "";

  if (!state.currentList.items.length) {
    container.innerHTML = `<div class="text-center text-muted small py-3">Nenhum item adicionado ainda.</div>`;
    return;
  }

  const items = [...state.currentList.items].sort((a, b) => a.category.localeCompare(b.category));

  items.forEach((item, idx) => {
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
          <button class="btn btn-sm btn-link text-danger p-0" onclick="removeItemFromList(${idx})">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

async function saveAndEnterShoppingMode() {
  const dateInput = document.getElementById('listDate').value || getTodayIsoDate();
  state.currentList.date = dateInput;
  state.currentList.name = dateInput;

  const isExisting = state.lists.some(l => l.id === state.currentList.id);
  const action = isExisting ? "updateList" : "saveList";

  const res = await apiCall("POST", { action, list: state.currentList });
  if (res && res.lists) {
    state.lists = res.lists;
    state.catalog = res.catalog;
    if (res.categories && res.categories.length) {
      state.categories = res.categories;
    }
  } else {
    const idx = state.lists.findIndex(l => l.id === state.currentList.id);
    if (idx >= 0) state.lists[idx] = state.currentList;
    else state.lists.push(state.currentList);
  }

  openShoppingMode(state.currentList);
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
    renderShoppingItems();
  }
}

async function exitShoppingMode() {
  await apiCall("POST", { action: "updateList", list: state.currentList });
  renderHome();
}

async function finishShopping() {
  if (!confirm("Deseja marcar esta lista como compra concluída?")) return;
  state.currentList.status = "concluida";
  state.currentList.completedAt = new Date().toISOString();
  await apiCall("POST", { action: "updateList", list: state.currentList });
  renderHome();
}

// ========================================================
// TELA 4: GERENCIAR CATEGORIAS (Com atualização garantida)
// ========================================================
async function openCategoriesView() {
  // Sincroniza do banco antes de listar
  await syncDataFromBackend();
  switchView('viewCategories');
  document.getElementById('pageTitle').innerText = "Configurar Categorias";
  renderCategoriesList();
}

function renderCategoriesList() {
  const container = document.getElementById('categoriesListContainer');
  container.innerHTML = "";

  state.categories.forEach((cat, idx) => {
    const item = document.createElement('div');
    item.className = "d-flex justify-content-between align-items-center p-2 rounded mb-2 border";
    item.style.backgroundColor = cat.color;
    item.innerHTML = `
      <span class="fw-bold text-dark">${cat.name}</span>
      <div class="d-flex gap-2 align-items-center">
        <input type="color" class="form-control form-control-color form-control-sm" value="${cat.color}" onchange="updateCatColor(${idx}, this.value)" title="Mudar cor">
        <button class="btn btn-sm btn-outline-danger" onclick="deleteCategory(${idx})">
          <i class="bi bi-trash3"></i>
        </button>
      </div>
    `;
    container.appendChild(item);
  });
}

async function createCategoryFromManager() {
  const name = document.getElementById('manageCatName').value.trim();
  const color = document.getElementById('manageCatColor').value;
  if (!name) return alert("Informe o nome da categoria.");

  const exists = state.categories.some(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) return alert("Esta categoria já existe.");

  state.categories.push({ id: "cat_" + Date.now(), name, color });
  document.getElementById('manageCatName').value = "";
  renderCategoriesList();
  await apiCall("POST", { action: "saveCategories", categories: state.categories });
}

async function updateCatColor(idx, color) {
  state.categories[idx].color = color;
  renderCategoriesList();
  await apiCall("POST", { action: "saveCategories", categories: state.categories });
}

async function deleteCategory(idx) {
  if (!confirm("Deseja excluir esta categoria?")) return;
  state.categories.splice(idx, 1);
  renderCategoriesList();
  await apiCall("POST", { action: "saveCategories", categories: state.categories });
}

function goHome() {
  renderHome();
}

// Iniciar aplicação
window.onload = init;
