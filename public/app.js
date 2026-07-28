const elements = {
    status: document.getElementById('agent-status'),
    runBtn: document.getElementById('run-btn'),
    model: document.getElementById('stat-model'),
    runs: document.getElementById('stat-runs'),
    next: document.getElementById('stat-next'),
    last: document.getElementById('stat-last'),
    thought: document.getElementById('last-thought'),
    shortCount: document.getElementById('short-count'),
    longCount: document.getElementById('long-count'),
    shortList: document.getElementById('short-mem-list'),
    longList: document.getElementById('long-mem-list'),
    logList: document.getElementById('log-list'),
    searchInput: document.getElementById('search-ltm'),
    chatInput: document.getElementById('chat-input'),
    chatBtn: document.getElementById('send-msg-btn'),
    chatHistory: document.getElementById('chat-history')
};

function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function updateStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        elements.status.textContent = data.status.toUpperCase();
        elements.status.className = `status-badge ${data.status}`;
        
        elements.runBtn.disabled = data.status !== 'idle';
        
        elements.model.textContent = data.model;
        elements.runs.textContent = data.totalRuns;
        elements.next.textContent = formatDate(data.nextRunAt);
        elements.last.textContent = formatDate(data.lastRun);
        
        if (data.lastThought) {
            elements.thought.textContent = data.lastThought;
        }

        elements.shortCount.textContent = data.shortCount;
        elements.longCount.textContent = data.longCount;
        
    } catch (e) {
        console.error('Failed to update status', e);
    }
}

async function updateMemory() {
    try {
        const [shortRes, longRes] = await Promise.all([
            fetch('/api/memory/short'),
            fetch(`/api/memory/search?q=${encodeURIComponent(elements.searchInput.value)}`)
        ]);
        
        const shortMem = await shortRes.json();
        const longMem = await longRes.json();
        
        renderMemory(shortMem, elements.shortList, 'short');
        renderMemory(longMem, elements.longList, 'long');
    } catch (e) {
        console.error('Failed to update memory', e);
    }
}

function renderMemory(items, container, kind) {
    container.innerHTML = '';
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'memory-item';
        
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.title = 'Удалить';
        delBtn.textContent = '×';
        delBtn.onclick = () => deleteMemory(kind, item.id);
        div.appendChild(delBtn);

        const typeSpan = document.createElement('span');
        typeSpan.className = 'type';
        typeSpan.textContent = item.type;
        div.appendChild(typeSpan);

        if (item.priority) {
            const prioSpan = document.createElement('span');
            prioSpan.className = 'priority';
            prioSpan.textContent = item.priority;
            div.appendChild(prioSpan);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'content';
        contentDiv.textContent = item.content;
        div.appendChild(contentDiv);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'meta';

        const tagsSpan = document.createElement('span');
        if (item.tags) {
            tagsSpan.textContent = '🏷️ ' + item.tags;
        } else {
            tagsSpan.textContent = 'ID: ' + item.id;
        }
        metaDiv.appendChild(tagsSpan);

        const timeSpan = document.createElement('span');
        timeSpan.textContent = item.created ? item.created.split(' ')[1] : '';
        metaDiv.appendChild(timeSpan);

        div.appendChild(metaDiv);
        container.appendChild(div);
    });
}

async function updateLogs() {
    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        
        elements.logList.innerHTML = '';
        logs.forEach(log => {
            const div = document.createElement('div');
            div.className = 'log-item';
            div.textContent = log.name;
            div.onclick = () => alert(log.content);
            elements.logList.appendChild(div);
        });
    } catch (e) {
        console.error('Failed to update logs', e);
    }
}

window.deleteMemory = async function(kind, id) {
    if(!confirm(`Удалить запись #${id}?`)) return;
    try {
        await fetch('/api/memory/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, id })
        });
        updateMemory();
        updateStatus();
    } catch (e) {
        console.error('Delete failed', e);
    }
};

elements.runBtn.addEventListener('click', async () => {
    try {
        elements.runBtn.disabled = true;
        await fetch('/api/run', { method: 'POST' });
        updateStatus();
        setTimeout(() => {
            updateMemory();
            updateLogs();
        }, 2000);
    } catch (e) {
        console.error('Run failed', e);
        elements.runBtn.disabled = false;
    }
});

let searchTimeout;
elements.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(updateMemory, 300);
});

// Chat logic
elements.chatBtn.addEventListener('click', async () => {
    const text = elements.chatInput.value.trim();
    if (!text) return;
    
    elements.chatInput.value = '';
    
    try {
        await fetch('/api/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        updateStatus(); // Update status immediately
        updateChat();
        
        // Wait a bit and update memory/logs just in case agent reacted
        setTimeout(() => {
            updateStatus();
            updateMemory();
            updateLogs();
            updateChat();
        }, 3000);
    } catch (e) {
        console.error('Failed to send message', e);
    }
});

elements.chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') elements.chatBtn.click();
});

async function updateChat() {
    try {
        const res = await fetch('/api/chat');
        const history = await res.json();
        
        if (history.length === 0) return;
        
        elements.chatHistory.innerHTML = '';
        history.forEach(msg => {
            const div = document.createElement('div');
            div.className = `chat-msg ${msg.sender}`;
            div.textContent = msg.text;
            elements.chatHistory.appendChild(div);
        });
        elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    } catch(e) {
        console.error('Failed to update chat', e);
    }
}

// Initial load
updateStatus();
updateMemory();
updateLogs();
updateChat();

// Poll periodically
setInterval(() => {
    updateStatus();
    updateChat();
}, 5000);
