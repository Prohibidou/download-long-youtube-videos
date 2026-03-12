import os
import uuid
import json
import threading
from flask import Flask, render_template, request, jsonify, send_file, Response
import yt_dlp

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Downloads go to user's home folder (outside OneDrive) to avoid file locking
DOWNLOAD_DIR = os.path.join(os.path.expanduser('~'), 'YouTubeDownloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Store download progress per task
progress_store = {}


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/info', methods=['POST'])
def get_info():
    data = request.get_json()
    url = data.get('url', '').strip()

    if not url:
        return jsonify({'error': 'URL es requerida'}), 400

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'extractor_args': {'youtube': {'player_client': ['mweb']}},
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            # Collect available quality options
            formats = info.get('formats', [])
            qualities = set()
            for f in formats:
                height = f.get('height')
                if height and height >= 360:
                    qualities.add(height)

            qualities = sorted(qualities, reverse=True)

            # Duration formatting
            duration = info.get('duration', 0)
            mins, secs = divmod(duration, 60)
            hours, mins = divmod(mins, 60)
            if hours:
                duration_str = f'{int(hours)}:{int(mins):02d}:{int(secs):02d}'
            else:
                duration_str = f'{int(mins)}:{int(secs):02d}'

            return jsonify({
                'title': info.get('title', 'Sin título'),
                'thumbnail': info.get('thumbnail', ''),
                'duration': duration_str,
                'channel': info.get('channel', info.get('uploader', 'Desconocido')),
                'view_count': info.get('view_count', 0),
                'qualities': qualities,
            })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


def has_ffmpeg():
    """Check if ffmpeg is available on the system."""
    import shutil
    return shutil.which('ffmpeg') is not None


def convert_to_cfr(task_id, filename):
    """Convert a VFR video to CFR (Constant Frame Rate) for Adobe Premiere compatibility."""
    import subprocess

    input_path = os.path.join(DOWNLOAD_DIR, filename)
    base, ext = os.path.splitext(filename)
    output_filename = base + '_premiere' + ext
    output_path = os.path.join(DOWNLOAD_DIR, output_filename)

    cmd = [
        'ffmpeg', '-i', input_path,
        '-c:v', 'libx264',         # H.264 codec (Premiere-friendly)
        '-preset', 'fast',          # Fast encoding for long videos
        '-crf', '18',               # High quality
        '-r', '30',                 # Force 30fps constant
        '-fps_mode', 'cfr',         # Constant frame rate (replaces deprecated -vsync)
        '-c:a', 'aac',              # AAC audio
        '-b:a', '192k',             # Good audio bitrate
        '-movflags', '+faststart',  # Web-optimized MP4
        '-y',                       # Overwrite output
        output_path
    ]

    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        # Remove original VFR file, keep only the CFR version
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            os.remove(input_path)
            return output_filename
        else:
            print(f"[Premiere] Output file is empty or missing: {output_path}")
            return filename
    except subprocess.CalledProcessError as e:
        print(f"[Premiere] FFmpeg error: {e.stderr[:500] if e.stderr else 'unknown'}")
        # Clean up empty/failed output
        if os.path.exists(output_path):
            os.remove(output_path)
        return filename


def do_download(task_id, url, quality, premiere_mode=False):
    """Background download function."""
    progress_store[task_id] = {
        'status': 'downloading',
        'percent': 0,
        'speed': '',
        'eta': '',
        'filename': '',
        'error': None,
    }

    def progress_hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
            downloaded = d.get('downloaded_bytes', 0)
            if total > 0:
                progress_store[task_id]['percent'] = round((downloaded / total) * 100, 1)
            progress_store[task_id]['speed'] = d.get('_speed_str', '')
            progress_store[task_id]['eta'] = d.get('_eta_str', '')
        elif d['status'] == 'finished':
            progress_store[task_id]['percent'] = 100
            progress_store[task_id]['status'] = 'merging'

    ffmpeg_available = has_ffmpeg()

    # Build format selector based on ffmpeg availability
    if ffmpeg_available:
        if quality == 'best':
            format_sel = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
        else:
            format_sel = f'bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best'
    else:
        # No ffmpeg: download best single format with both video+audio
        if quality == 'best':
            format_sel = 'best[ext=mp4]/best'
        else:
            format_sel = f'best[height<={quality}][ext=mp4]/best[height<={quality}]/best[ext=mp4]/best'

    output_template = os.path.join(DOWNLOAD_DIR, f'{task_id}_%(id)s.%(ext)s')

    ydl_opts = {
        'format': format_sel,
        'outtmpl': output_template,
        'progress_hooks': [progress_hook],
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtube': {'player_client': ['mweb']}},
    }

    if ffmpeg_available:
        ydl_opts['merge_output_format'] = 'mp4'

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_title = info.get('title', 'video')

            # Find the actual downloaded file by scanning the downloads dir
            actual_file = None
            for f in os.listdir(DOWNLOAD_DIR):
                if f.startswith(task_id) and not f.endswith('.part'):
                    actual_file = f
                    break

            if actual_file:
                # Adobe Premiere mode: convert VFR to CFR
                if premiere_mode and ffmpeg_available:
                    progress_store[task_id]['status'] = 'converting'
                    actual_file = convert_to_cfr(task_id, actual_file)

                # Build a clean display name from the video title
                ext = os.path.splitext(actual_file)[1]
                # Sanitize title for display (remove chars illegal in Windows filenames)
                safe_title = ''.join(c if c not in r'<>:"/\|?*' else '_' for c in video_title)
                display_name = safe_title + ext

                progress_store[task_id]['status'] = 'done'
                progress_store[task_id]['filename'] = actual_file
                progress_store[task_id]['display_name'] = display_name
            else:
                progress_store[task_id]['status'] = 'error'
                progress_store[task_id]['error'] = 'No se encontro el archivo descargado'
    except Exception as e:
        progress_store[task_id]['status'] = 'error'
        progress_store[task_id]['error'] = str(e)



@app.route('/api/download', methods=['POST'])
def start_download():
    data = request.get_json()
    url = data.get('url', '').strip()
    quality = data.get('quality', 'best')
    premiere_mode = data.get('premiere', False)

    if not url:
        return jsonify({'error': 'URL es requerida'}), 400

    task_id = str(uuid.uuid4())[:8]

    thread = threading.Thread(target=do_download, args=(task_id, url, quality, premiere_mode))
    thread.daemon = True
    thread.start()

    return jsonify({'task_id': task_id})


@app.route('/api/progress/<task_id>')
def get_progress(task_id):
    def generate():
        import time
        while True:
            info = progress_store.get(task_id, {})
            if not info:
                yield f"data: {json.dumps({'status': 'unknown'})}\n\n"
                break

            yield f"data: {json.dumps(info)}\n\n"

            if info.get('status') in ('done', 'error'):
                break

            time.sleep(0.5)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/file/<filename>')
def download_file(filename):
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    if os.path.exists(filepath):
        # Use the display name from query param, fallback to filename
        display_name = request.args.get('name', filename)
        return send_file(filepath, as_attachment=True, download_name=display_name)
    return jsonify({'error': 'Archivo no encontrado'}), 404


if __name__ == '__main__':
    print("\n  >> YouTube HD Downloader")
    print("  Abre http://localhost:5000 en tu navegador\n")
    app.run(debug=True, port=5000, threaded=True)
