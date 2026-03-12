// ===== DOM Elements =====
const urlInput = document.getElementById('urlInput');
const clearBtn = document.getElementById('clearBtn');
const fetchBtn = document.getElementById('fetchBtn');
const errorMsg = document.getElementById('errorMsg');
const videoInfo = document.getElementById('videoInfo');
const thumbnail = document.getElementById('thumbnail');
const videoTitle = document.getElementById('videoTitle');
const videoChannel = document.getElementById('videoChannel');
const viewCount = document.getElementById('viewCount');
const duration = document.getElementById('duration');
const qualitySelect = document.getElementById('qualitySelect');
const downloadBtn = document.getElementById('downloadBtn');
const premiereCheck = document.getElementById('premiereCheck');
const progressSection = document.getElementById('progressSection');
const progressTitle = document.getElementById('progressTitle');
const progressPercent = document.getElementById('progressPercent');
const progressBar = document.getElementById('progressBar');
const progressSpeed = document.getElementById('progressSpeed');
const progressEta = document.getElementById('progressEta');
const doneSection = document.getElementById('doneSection');
const doneFilename = document.getElementById('doneFilename');
const downloadLink = document.getElementById('downloadLink');

let currentUrl = '';

// ===== Input Events =====
urlInput.addEventListener('input', () => {
    clearBtn.style.display = urlInput.value ? 'flex' : 'none';
});

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchBtn.click();
});

clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    hideAll();
    urlInput.focus();
});

// ===== Fetch Video Info =====
fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
        showError('Por favor, ingresa una URL de YouTube');
        return;
    }

    hideAll();
    setLoading(fetchBtn, true);

    try {
        const res = await fetch('/api/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });

        const data = await res.json();

        if (!res.ok) {
            showError(data.error || 'Error al obtener información del video');
            return;
        }

        currentUrl = url;
        showVideoInfo(data);
    } catch (err) {
        showError('Error de conexión. ¿Está el servidor corriendo?');
    } finally {
        setLoading(fetchBtn, false);
    }
});

// ===== Show Video Info =====
function showVideoInfo(data) {
    thumbnail.src = data.thumbnail;
    videoTitle.textContent = data.title;
    videoChannel.textContent = data.channel;
    duration.textContent = data.duration;

    // Format view count
    const views = data.view_count;
    if (views >= 1_000_000) {
        viewCount.textContent = `${(views / 1_000_000).toFixed(1)}M vistas`;
    } else if (views >= 1_000) {
        viewCount.textContent = `${(views / 1_000).toFixed(1)}K vistas`;
    } else {
        viewCount.textContent = `${views} vistas`;
    }

    // Populate quality selector
    qualitySelect.innerHTML = '';
    
    // Add "Mejor calidad" option
    const bestOpt = document.createElement('option');
    bestOpt.value = 'best';
    bestOpt.textContent = '🏆 Mejor calidad disponible';
    qualitySelect.appendChild(bestOpt);

    data.qualities.forEach(q => {
        const opt = document.createElement('option');
        opt.value = q;
        let label = `${q}p`;
        if (q >= 1080) label += ' (Full HD)';
        else if (q >= 720) label += ' (HD)';
        else if (q >= 480) label += ' (SD)';
        opt.textContent = label;
        if (q === 1080) opt.selected = true;
        qualitySelect.appendChild(opt);
    });

    // If 1080 is available, select it by default
    const has1080 = data.qualities.includes(1080);
    if (has1080) {
        qualitySelect.value = '1080';
    }

    videoInfo.style.display = 'block';
}

// ===== Download =====
downloadBtn.addEventListener('click', async () => {
    const quality = qualitySelect.value;

    setLoading(downloadBtn, true);
    downloadBtn.disabled = true;

    try {
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: currentUrl, quality, premiere: premiereCheck.checked }),
        });

        const data = await res.json();

        if (!res.ok) {
            showError(data.error || 'Error al iniciar la descarga');
            setLoading(downloadBtn, false);
            downloadBtn.disabled = false;
            return;
        }

        // Show progress
        videoInfo.style.display = 'none';
        progressSection.style.display = 'block';
        trackProgress(data.task_id);
    } catch (err) {
        showError('Error de conexión al iniciar la descarga');
        setLoading(downloadBtn, false);
        downloadBtn.disabled = false;
    }
});

// ===== Track Progress via SSE =====
function trackProgress(taskId) {
    const evtSource = new EventSource(`/api/progress/${taskId}`);

    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.status === 'downloading') {
            progressTitle.textContent = 'Descargando...';
            progressPercent.textContent = `${data.percent}%`;
            progressBar.style.width = `${data.percent}%`;
            progressSpeed.textContent = data.speed ? `Velocidad: ${data.speed}` : '';
            progressEta.textContent = data.eta ? `Tiempo restante: ${data.eta}` : '';
        } else if (data.status === 'merging') {
            progressTitle.textContent = 'Combinando video y audio...';
            progressPercent.textContent = '99%';
            progressBar.style.width = '99%';
            progressSpeed.textContent = '';
            progressEta.textContent = 'Casi listo...';
        } else if (data.status === 'converting') {
            progressTitle.textContent = 'Optimizando para Adobe Premiere...';
            progressPercent.textContent = '';
            progressBar.style.width = '100%';
            progressSpeed.textContent = 'Convirtiendo VFR a CFR (H.264)';
            progressEta.textContent = 'Esto puede tardar unos minutos...';
        } else if (data.status === 'done') {
            evtSource.close();
            showDone(data.filename, data.display_name || data.filename);
        } else if (data.status === 'error') {
            evtSource.close();
            progressSection.style.display = 'none';
            showError(data.error || 'Error durante la descarga');
            resetDownloadBtn();
        }
    };

    evtSource.onerror = () => {
        evtSource.close();
        // Check one more time if it completed
        setTimeout(async () => {
            try {
                const res = await fetch(`/api/progress/${taskId}`);
                // If we can't reconnect, just show error
                progressSection.style.display = 'none';
                showError('Se perdió la conexión con el servidor');
                resetDownloadBtn();
            } catch {
                progressSection.style.display = 'none';
                showError('Se perdió la conexión con el servidor');
                resetDownloadBtn();
            }
        }, 1000);
    };
}

// ===== Show Done =====
let savedFileUrl = '';
let savedDisplayName = '';

function showDone(filename, displayName) {
    progressSection.style.display = 'none';
    doneSection.style.display = 'block';
    doneFilename.textContent = displayName;
    savedFileUrl = `/api/file/${encodeURIComponent(filename)}`;
    savedDisplayName = displayName;
    resetDownloadBtn();
}

// Blob-based download to guarantee correct filename
downloadLink.addEventListener('click', async () => {
    if (!savedFileUrl) return;

    downloadLink.disabled = true;
    downloadLink.querySelector('span').textContent = 'Descargando...';

    try {
        const response = await fetch(savedFileUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = savedDisplayName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        downloadLink.querySelector('span').textContent = 'Guardar Archivo';
        downloadLink.disabled = false;
    } catch (err) {
        showError('Error al guardar el archivo');
        downloadLink.querySelector('span').textContent = 'Guardar Archivo';
        downloadLink.disabled = false;
    }
});

// ===== Helpers =====
function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    setTimeout(() => {
        errorMsg.style.display = 'none';
    }, 6000);
}

function hideAll() {
    errorMsg.style.display = 'none';
    videoInfo.style.display = 'none';
    progressSection.style.display = 'none';
    doneSection.style.display = 'none';
}

function setLoading(btn, loading) {
    if (loading) {
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span><span>Cargando...</span>';
        btn.disabled = true;
    } else {
        btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
        btn.disabled = false;
    }
}

function resetDownloadBtn() {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span>Descargar Video</span>
    `;
}

// Auto-focus input on load
window.addEventListener('DOMContentLoaded', () => {
    urlInput.focus();
});
