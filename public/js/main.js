document.addEventListener('DOMContentLoaded', async () => {
    // State
    let endpoints = [];
    let history = [];
    let activeBinId = localStorage.getItem('freeceptor_bin_id');
    let baseUrlContext = ''; // This will store http://localhost:3000/b/1234 or the prod url

    // DOM Elements - Navigation
    const tabEndpoints = document.getElementById('tab-endpoints');
    const tabHistory = document.getElementById('tab-history');
    const viewEndpoints = document.getElementById('view-endpoints');
    const viewHistory = document.getElementById('view-history');
    const tabNewWorkspace = document.getElementById('tab-new-workspace');

    // DOM Elements - Bin
    const displayBinUrl = document.getElementById('display-bin-url');
    const btnCopyUrl = document.getElementById('btn-copy-url');

    // DOM Elements - Endpoints
    const btnAddRule = document.getElementById('btn-add-rule');
    const endpointsTable = document.getElementById('endpoints-table');
    const endpointsBody = document.getElementById('endpoints-body');
    const noEndpoints = document.getElementById('no-endpoints');

    // DOM Elements - History
    const btnRefreshHistory = document.getElementById('btn-refresh-history');
    const btnClearHistory = document.getElementById('btn-clear-history');
    const historyList = document.getElementById('history-list');
    const noHistory = document.getElementById('no-history');

    // DOM Elements - Modal
    const modalAddRule = document.getElementById('modal-add-rule');
    const btnCloseModal = document.getElementById('btn-close-modal');
    const btnCancelRule = document.getElementById('btn-cancel-rule');
    const formAddRule = document.getElementById('form-add-rule');
    
    // DOM Elements - Form Fields
    const ruleRandom = document.getElementById('rule-random');
    const jsonBodyGroup = document.getElementById('json-body-group');
    const toast = document.getElementById('toast');

    // --- Bin Initialization ---
    async function initializeBin() {
        try {
            const res = await fetch('/api/bins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ binId: activeBinId })
            });
            const data = await res.json();
            
            // Save to state and local storage
            activeBinId = data.binId;
            localStorage.setItem('freeceptor_bin_id', activeBinId);
            
            baseUrlContext = `${data.baseUrl}/b/${activeBinId}`;
            displayBinUrl.textContent = baseUrlContext;
            
            // Now load data
            fetchEndpoints();
        } catch (error) {
            showToast('Failed to initialize workspace', true);
            console.error('Init error:', error);
        }
    }

    // --- Navigation Logic ---
    tabEndpoints.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveTab(tabEndpoints, viewEndpoints);
        fetchEndpoints();
    });

    tabHistory.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveTab(tabHistory, viewHistory);
        fetchHistory();
    });

    tabNewWorkspace.addEventListener('click', (e) => {
        e.preventDefault();
        if(confirm("Create a new workspace? You will lose access to the current one unless you saved its URL.")) {
            localStorage.removeItem('freeceptor_bin_id');
            activeBinId = null;
            history = [];
            endpoints = [];
            renderHistory();
            renderEndpoints();
            setActiveTab(tabEndpoints, viewEndpoints);
            initializeBin();
        }
    });

    function setActiveTab(tab, view) {
        document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        tab.classList.add('active');
        view.classList.remove('hidden');
    }

    // --- Modal Logic ---
    function openModal() { modalAddRule.classList.remove('hidden'); }
    function closeModal() {
        modalAddRule.classList.add('hidden');
        formAddRule.reset();
        jsonBodyGroup.style.display = 'flex';
    }

    btnAddRule.addEventListener('click', openModal);
    btnCloseModal.addEventListener('click', closeModal);
    btnCancelRule.addEventListener('click', closeModal);
    modalAddRule.addEventListener('click', (e) => {
        if (e.target === modalAddRule) closeModal();
    });

    ruleRandom.addEventListener('change', (e) => {
        jsonBodyGroup.style.display = e.target.checked ? 'none' : 'flex';
    });

    // --- Utilities ---
    function showToast(message, isError = false) {
        toast.textContent = message;
        toast.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    btnCopyUrl.addEventListener('click', () => {
        navigator.clipboard.writeText(baseUrlContext);
        
        const originalText = btnCopyUrl.textContent;
        btnCopyUrl.textContent = 'Copied!';
        setTimeout(() => btnCopyUrl.textContent = originalText, 2000);
    });

    // --- API Calls ---
    function getAuthHeaders() {
        return { 
            'Content-Type': 'application/json',
            'x-bin-id': activeBinId 
        };
    }

    async function fetchEndpoints() {
        if (!activeBinId) return;
        try {
            const res = await fetch(`/api/b/${activeBinId}/endpoints`, { headers: getAuthHeaders() });
            endpoints = await res.json();
            renderEndpoints();
        } catch (error) {
            console.error('fetchEndpoints error:', error);
        }
    }

    async function fetchHistory() {
        if (!activeBinId) return;
        try {
            const res = await fetch(`/api/b/${activeBinId}/history`, { headers: getAuthHeaders() });
            history = await res.json();
            renderHistory();
        } catch (error) {
            console.error('fetchHistory error:', error);
        }
    }

    async function deleteEndpoint(id) {
        try {
            const res = await fetch(`/api/b/${activeBinId}/endpoints/${id}`, { 
                method: 'DELETE',
                headers: getAuthHeaders()
            });
            if (res.ok) {
                showToast('Mock rule deleted');
                fetchEndpoints();
            }
        } catch (error) {
            showToast('Error deleting rule', true);
        }
    }

    btnRefreshHistory.addEventListener('click', fetchHistory);
    
    btnClearHistory.addEventListener('click', async () => {
        if(!confirm("Clear all request history?")) return;
        try {
            await fetch(`/api/b/${activeBinId}/history`, { 
                method: 'DELETE',
                headers: getAuthHeaders()
            });
            showToast('History cleared');
            fetchHistory();
        } catch (error) {}
    });

    // --- Render Functions ---
    function renderEndpoints() {
        endpointsBody.innerHTML = '';
        
        if (endpoints.length === 0) {
            endpointsTable.style.display = 'none';
            noEndpoints.classList.remove('hidden');
        } else {
            endpointsTable.style.display = 'table';
            noEndpoints.classList.add('hidden');
            
            endpoints.forEach(ep => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span class="method-badge method-${ep.method}">${ep.method}</span></td>
                    <td><span style="color:var(--text-muted)">/b/${activeBinId}</span>${ep.path === '/' ? '' : ep.path}</td>
                    <td><span class="code-badge">${ep.responseStatus}</span></td>
                    <td>${ep.useRandom ? 'Random Generation' : 'Custom JSON'}</td>
                    <td>
                        <button class="delete-btn" data-id="${ep.id}" title="Delete Rule">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
                        </button>
                    </td>
                `;
                tr.querySelector('.delete-btn').addEventListener('click', function() {
                    if(confirm("Are you sure you want to delete this mock rule?")) {
                        deleteEndpoint(this.getAttribute('data-id'));
                    }
                });
                endpointsBody.appendChild(tr);
            });
        }
    }

    function renderHistory() {
        historyList.innerHTML = '';
        
        if (history.length === 0) {
            historyList.appendChild(noHistory);
        } else {
            history.forEach(item => {
                const date = new Date(item.timestamp);
                const div = document.createElement('div');
                div.className = 'history-item';
                div.innerHTML = `
                    <div class="history-header">
                        <div class="req-info">
                            <span class="method-badge method-${item.method}">${item.method}</span>
                            <strong>${item.path === '/' ? '' : item.path}</strong>
                            ${item.ip ? `<span class="code-badge" style="font-size:0.75rem">${item.ip}</span>` : ''}
                        </div>
                        <span class="history-time">${date.toLocaleString()}</span>
                    </div>
                    <div class="history-details">
                        <pre>Headers: ${JSON.stringify(item.headers, null, 2)}
Query: ${JSON.stringify(item.query, null, 2)}
Body: ${JSON.stringify(item.body, null, 2)}</pre>
                    </div>
                `;
                historyList.appendChild(div);
            });
        }
    }

    // --- Form Submission ---
    formAddRule.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const payload = {
            method: document.getElementById('rule-method').value,
            path: document.getElementById('rule-path').value,
            responseStatus: document.getElementById('rule-status').value,
            useRandom: document.getElementById('rule-random').checked,
            responseBody: document.getElementById('rule-body').value
        };
        
        if (!payload.useRandom) {
            try {
                if(payload.responseBody.trim() !== '') JSON.parse(payload.responseBody);
                else payload.responseBody = "{}";
            } catch (err) {
                alert("Invalid JSON format. Please format correctly.");
                return;
            }
        }

        try {
            const res = await fetch(`/api/b/${activeBinId}/endpoints`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(payload)
            });
            
            if (res.ok) {
                showToast('Mock rule created');
                closeModal();
                fetchEndpoints();
            } else { showToast('Failed to create rule', true); }
        } catch (error) {
            showToast('Error creating rule', true);
        }
    });

    // Start App
    initializeBin();
});
