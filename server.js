const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '500mb' }));

const PORT = process.env.PORT || 3000;
const WORK_DIR = '/tmp/longform_work';
const BG_MUSIC_PATH = '/app/assets/bg_music.mp3';

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanup(dir) {
  try { execSync(`rm -rf "${dir}"`); } catch (e) {}
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const request = protocol.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Download failed: ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(new Error(`Network error: ${err.message}`));
    });
    request.setTimeout(300000, () => {
      request.destroy();
      reject(new Error(`Download timeout: ${url}`));
    });
  });
}

function runFFmpeg(cmd, label) {
  return new Promise((resolve, reject) => {
    console.log(`  [ffmpeg] ${label || cmd.substring(0, 80)}`);
    exec(cmd, { maxBuffer: 1024 * 1024 * 500 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`FFmpeg failed (${label}): ${stderr ? stderr.slice(-1500) : err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function getAudioDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration ` +
    `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  ).toString().trim();
  return parseFloat(out);
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  try {
    const ffmpegVersion = execSync('ffmpeg -version').toString().split('\n')[0];
    const musicExists = fs.existsSync(BG_MUSIC_PATH);
    const musicSize = musicExists
      ? `${(fs.statSync(BG_MUSIC_PATH).size / 1024 / 1024).toFixed(1)}MB`
      : 'MISSING';
    res.json({ status: 'ok', time: new Date().toISOString(), ffmpeg: ffmpegVersion, bg_music: musicSize });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ─── MAIN ASSEMBLY ENDPOINT ───────────────────────────────────────────────────

app.post('/assemble', async (req, res) => {
  const jobId = Date.now().toString();
  const workDir = path.join(WORK_DIR, jobId);
  ensureDir(workDir);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[${jobId}] Long-form assembly started`);
  console.log(`[${jobId}] Images: ${req.body.image_urls?.length || 0} | Target: ${req.body.target_duration_s || 750}s`);

  try {
    const {
      voiceover_audio_b64,
      voiceover_word_timestamps,
      image_urls,
      chapter_markers,   // [{title, start_time_s, image_index}]
      srt_content,
      title,
      target_duration_s = 750
    } = req.body;

    if (!voiceover_audio_b64) throw new Error('Missing voiceover_audio_b64');
    if (!image_urls || image_urls.length === 0) throw new Error('Missing image_urls');

    // ── STEP 1: Write voiceover audio ────────────────────────────────────
    console.log(`[${jobId}] Step 1: Writing voiceover audio`);
    const voiceoverPath = path.join(workDir, 'voiceover.mp3');
    fs.writeFileSync(voiceoverPath, Buffer.from(voiceover_audio_b64, 'base64'));
    const voiceoverDuration = getAudioDuration(voiceoverPath);
    console.log(`[${jobId}]   Voiceover duration: ${voiceoverDuration.toFixed(1)}s`);

    // ── STEP 2: Build looping background music track ──────────────────────
    console.log(`[${jobId}] Step 2: Building looping background music`);

    if (!fs.existsSync(BG_MUSIC_PATH)) {
      throw new Error(`Background music not found at ${BG_MUSIC_PATH}. Check Docker build.`);
    }

    const musicDuration = getAudioDuration(BG_MUSIC_PATH);
    console.log(`[${jobId}]   Music track: ${musicDuration.toFixed(1)}s — needs to fill ${voiceoverDuration.toFixed(1)}s`);

    // Build a looped music file with 3s silence gap between loops
    // Strategy: create silence, concat [music + silence] N times, trim to voiceover length
    const silencePath = path.join(workDir, 'silence_3s.mp3');
    await runFFmpeg(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 "${silencePath}"`,
      'generate 3s silence'
    );

    // Build concat list: music, silence, music, silence... enough loops
    const loopsNeeded = Math.ceil(voiceoverDuration / (musicDuration + 3)) + 2;
    const musicConcatList = path.join(workDir, 'music_concat.txt');
    let concatContent = '';
    for (let i = 0; i < loopsNeeded; i++) {
      concatContent += `file '${BG_MUSIC_PATH}'\nfile '${silencePath}'\n`;
    }
    fs.writeFileSync(musicConcatList, concatContent);

    const loopedMusicRaw = path.join(workDir, 'music_looped_raw.mp3');
    await runFFmpeg(
      `ffmpeg -y -f concat -safe 0 -i "${musicConcatList}" -c copy "${loopedMusicRaw}"`,
      'concat music loops'
    );

    // Trim to voiceover duration + 3s tail, apply fade-in on each loop restart
    // and fade out at the very end
    const loopedMusicPath = path.join(workDir, 'music_looped.mp3');
    const fadeDuration = 4.0; // 4s fade in on each loop restart
    const totalMusicLen = voiceoverDuration + 3;

    // Build afade filter for loop restarts
    let fadeFilters = [];
    let loopStart = 0;
    while (loopStart < totalMusicLen) {
      if (loopStart > 0) {
        // Fade in after each silence gap
        fadeFilters.push(`afade=t=in:st=${loopStart}:d=${fadeDuration}`);
      }
      loopStart += musicDuration + 3;
    }
    // Final fade out
    const fadeOutStart = Math.max(0, voiceoverDuration - 4);
    fadeFilters.push(`afade=t=out:st=${fadeOutStart}:d=4`);

    const musicFilter = fadeFilters.length > 0
      ? `-af "${fadeFilters.join(',')}"` 
      : '';

    await runFFmpeg(
      `ffmpeg -y -i "${loopedMusicRaw}" -t ${totalMusicLen.toFixed(3)} ${musicFilter} "${loopedMusicPath}"`,
      'trim and fade music'
    );

    // ── STEP 3: Mix voiceover + background music ──────────────────────────
    console.log(`[${jobId}] Step 3: Mixing voiceover + background music`);
    const mixedAudioPath = path.join(workDir, 'audio_mixed.mp3');

    // Voiceover at 100% volume, music at 22% volume
    await runFFmpeg(
      `ffmpeg -y ` +
      `-i "${voiceoverPath}" ` +
      `-i "${loopedMusicPath}" ` +
      `-filter_complex "[0:a]volume=1.0[vo];[1:a]volume=0.22[bg];[vo][bg]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
      `-map "[aout]" -c:a aac -b:a 192k "${mixedAudioPath}"`,
      'mix voiceover and music'
    );

    const finalAudioDuration = getAudioDuration(mixedAudioPath);
    console.log(`[${jobId}]   Mixed audio: ${finalAudioDuration.toFixed(1)}s`);

    // ── STEP 4: Download all images ───────────────────────────────────────
    console.log(`[${jobId}] Step 4: Downloading ${image_urls.length} images`);
    const imagePaths = [];

    for (let i = 0; i < image_urls.length; i++) {
      const imgPath = path.join(workDir, `image_${i}.jpg`);
      await downloadFile(image_urls[i], imgPath);

      // Normalise to exactly 1920x1080 JPEG
      const normPath = path.join(workDir, `image_norm_${i}.jpg`);
      await runFFmpeg(
        `ffmpeg -y -i "${imgPath}" ` +
        `-vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuvj420p" ` +
        `-q:v 2 "${normPath}"`,
        `normalise image ${i + 1}`
      );
      imagePaths.push(normPath);
      console.log(`[${jobId}]   Image ${i + 1}/${image_urls.length} ready`);
    }

    // ── STEP 5: Calculate per-image duration ─────────────────────────────
    console.log(`[${jobId}] Step 5: Calculating image durations`);
    const imageCount = imagePaths.length;
    const perImageDuration = finalAudioDuration / imageCount;
    const fps = 24;

    console.log(`[${jobId}]   ${imageCount} images × ${perImageDuration.toFixed(1)}s each @ ${fps}fps`);

    // ── STEP 6: Apply Ken Burns effect to each image ──────────────────────
    console.log(`[${jobId}] Step 6: Applying Ken Burns effect (this takes the longest)`);
    const kenBurnsPaths = [];

    // Ken Burns patterns — alternating to add variety
    const kenBurnsPatterns = [
      // Slow zoom in from center
      { z: "1.0+0.00015*on", x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
      // Slow pan right + slight zoom
      { z: "1.04+0.00005*on", x: "iw*0.02+iw*0.0002*on", y: "ih/2-(ih/zoom/2)" },
      // Slow pan left + slight zoom
      { z: "1.04+0.00005*on", x: "iw*0.06-iw*0.0002*on", y: "ih/2-(ih/zoom/2)" },
      // Slow zoom in from top-left
      { z: "1.0+0.00015*on", x: "iw*0.1*(1-on/d)", y: "ih*0.1*(1-on/d)" },
      // Slow pan up
      { z: "1.05", x: "iw/2-(iw/zoom/2)", y: "ih*0.05+ih*0.0001*on" },
      // Slow zoom out (start zoomed, pull back)
      { z: "1.08-0.00012*on", x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
    ];

    for (let i = 0; i < imagePaths.length; i++) {
      const pattern = kenBurnsPatterns[i % kenBurnsPatterns.length];
      const totalFrames = Math.ceil(perImageDuration * fps);
      const kbPath = path.join(workDir, `kb_${i}.mp4`);

      // zoompan filter — this is the Ken Burns effect
      // d= total frames, fps= output framerate
      // Scale up 10% first so zoompan has room to move without black borders
      const zoompanFilter =
        `scale=2112:1188,` +  // 1920*1.1 x 1080*1.1
        `zoompan=` +
        `z='${pattern.z}':` +
        `x='${pattern.x}':` +
        `y='${pattern.y}':` +
        `d=${totalFrames}:` +
        `fps=${fps}:` +
        `s=1920x1080`;

      await runFFmpeg(
        `ffmpeg -y -loop 1 -i "${imagePaths[i]}" ` +
        `-vf "${zoompanFilter}" ` +
        `-t ${perImageDuration.toFixed(4)} ` +
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p ` +
        `-an "${kbPath}"`,
        `Ken Burns image ${i + 1}/${imagePaths.length}`
      );
      kenBurnsPaths.push(kbPath);
      console.log(`[${jobId}]   Ken Burns ${i + 1}/${imagePaths.length} done`);
    }

    // ── STEP 7: Crossfade between Ken Burns clips ─────────────────────────
    console.log(`[${jobId}] Step 7: Concatenating with crossfades`);

    // Use xfade filter for smooth 1-second crossfades between clips
    // Build a complex filter for chaining xfade
    const crossfadeDuration = 1.0; // 1s crossfade between images

    let videoPath;

    if (kenBurnsPaths.length === 1) {
      videoPath = kenBurnsPaths[0];
    } else {
      // Build xfade chain
      // For N clips: [0][1]xfade=duration=1:offset=D0[v01]; [v01][2]xfade=duration=1:offset=D1[v012]; ...
      let inputArgs = kenBurnsPaths.map(p => `-i "${p}"`).join(' ');
      let filterParts = [];
      let prevLabel = '[0:v]';
      let cumulativeOffset = 0;

      for (let i = 1; i < kenBurnsPaths.length; i++) {
        const offset = cumulativeOffset + perImageDuration - crossfadeDuration;
        const outLabel = i === kenBurnsPaths.length - 1 ? '[vout]' : `[v${i}]`;
        filterParts.push(
          `${prevLabel}[${i}:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${offset.toFixed(3)}${outLabel}`
        );
        prevLabel = outLabel;
        cumulativeOffset += perImageDuration - crossfadeDuration;
      }

      const concatVideoPath = path.join(workDir, 'video_concat.mp4');
      const complexFilter = filterParts.join(';');

      await runFFmpeg(
        `ffmpeg -y ${inputArgs} ` +
        `-filter_complex "${complexFilter}" ` +
        `-map "[vout]" ` +
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p ` +
        `"${concatVideoPath}"`,
        'crossfade concat'
      );
      videoPath = concatVideoPath;
    }

    // ── STEP 8: Merge video + mixed audio ────────────────────────────────
    console.log(`[${jobId}] Step 8: Merging video and audio`);
    const mergedPath = path.join(workDir, 'video_merged.mp4');
    await runFFmpeg(
      `ffmpeg -y -i "${videoPath}" -i "${mixedAudioPath}" ` +
      `-c:v copy -c:a copy -shortest "${mergedPath}"`,
      'merge video and audio'
    );

    // ── STEP 9: Write SRT captions ───────────────────────────────────────
    console.log(`[${jobId}] Step 9: Burning captions and chapter overlays`);
    const srtPath = path.join(workDir, 'captions.srt');
    fs.writeFileSync(srtPath, srt_content || '');
    const srtEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/ /g, '\\ ');

    // ── STEP 10: Build chapter title overlay filters ──────────────────────
    const drawtextFilters = [];

    if (chapter_markers && chapter_markers.length > 0) {
      chapter_markers.forEach((chapter) => {
        const title_text = (chapter.title || '')
          .replace(/\\/g, '')
          .replace(/'/g, '')
          .replace(/[^\w\s\-\:]/g, '')
          .trim();

        if (!title_text) return;

        const startT = chapter.start_time_s;
        const endT = startT + 4.0; // chapter title shows for 4 seconds

        // Large chapter title — centered, top third of frame
        drawtextFilters.push(
          `drawtext=` +
          `text='${title_text}':` +
          `fontcolor=white:` +
          `fontsize=64:` +
          `fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:` +
          `x=(w-text_w)/2:` +
          `y=h*0.08:` +
          `box=1:` +
          `boxcolor=black@0.65:` +
          `boxborderw=24:` +
          `alpha='if(lt(t,${startT}),0,if(lt(t,${(startT + 0.5).toFixed(2)}),((t-${startT})/0.5),if(lt(t,${(endT - 0.5).toFixed(2)}),1,((${endT}-t)/0.5))))':` +
          `enable='between(t,${startT.toFixed(2)},${endT.toFixed(2)})'`
        );
      });
    }

    // ── STEP 11: Burn subtitles + chapter overlays ────────────────────────
    const captionedPath = path.join(workDir, 'video_captioned.mp4');

    const subtitleStyle =
      `subtitles='${srtEscaped}':` +
      `force_style='` +
      `FontName=Liberation Sans Bold,` +
      `FontSize=22,` +
      `PrimaryColour=&H00FFFFFF,` +
      `OutlineColour=&H00000000,` +
      `BackColour=&H60000000,` +
      `Outline=2,` +
      `Shadow=1,` +
      `Alignment=2,` +
      `MarginV=60` +
      `'`;

    let vfChain = subtitleStyle;
    if (drawtextFilters.length > 0) {
      vfChain += ',' + drawtextFilters.join(',');
    }

    await runFFmpeg(
      `ffmpeg -y -i "${mergedPath}" ` +
      `-vf "${vfChain}" ` +
      `-c:v libx264 -preset fast -crf 18 -c:a copy "${captionedPath}"`,
      'burn subtitles and chapter overlays'
    );

    // ── STEP 12: Final grade ──────────────────────────────────────────────
    console.log(`[${jobId}] Step 12: Final colour grade`);
    const finalPath = path.join(workDir, 'final.mp4');
    await runFFmpeg(
      `ffmpeg -y -i "${captionedPath}" ` +
      `-vf "vignette=PI/7,eq=contrast=1.08:brightness=0.01:saturation=1.08:gamma=0.96" ` +
      `-c:v libx264 -preset medium -crf 17 -c:a copy "${finalPath}"`,
      'final colour grade'
    );

    // ── STEP 13: Read and return ──────────────────────────────────────────
    console.log(`[${jobId}] Step 13: Reading final output`);
    const finalBuffer = fs.readFileSync(finalPath);
    const video_b64 = finalBuffer.toString('base64');
    const filename = `history_${jobId}.mp4`;
    const fileSizeMB = (finalBuffer.length / 1024 / 1024).toFixed(1);

    console.log(`[${jobId}] ✓ Complete — ${fileSizeMB}MB — ${finalAudioDuration.toFixed(1)}s`);
    console.log(`${'='.repeat(70)}\n`);

    cleanup(workDir);

    res.json({
      success: true,
      video_b64,
      filename,
      duration_s: Math.round(finalAudioDuration * 10) / 10,
      file_size_mb: parseFloat(fileSizeMB)
    });

  } catch (err) {
    console.error(`[${jobId}] ✗ FAILED:`, err.message);
    cleanup(workDir);
    res.status(500).json({ success: false, error: err.message, job_id: jobId });
  }
});

app.listen(PORT, () => {
  console.log(`Long-form FFmpeg server running on port ${PORT}`);
  console.log(`Health: GET /health | Assembly: POST /assemble`);
});
