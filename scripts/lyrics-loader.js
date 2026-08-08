function loadLyrics(path,id){fetch(path).then(function(r){if(!r.ok)throw new Error();return r.text()}).then(function(t){document.getElementById(id).textContent=t}).catch(function(){document.getElementById(id).textContent="歌詞データを準備中です。"});}
loadLyrics("lyrics/kanata.txt?v=3","kanata-lyrics");
loadLyrics("lyrics/correct-answer.txt?v=1","correct-answer-lyrics");
loadLyrics("lyrics/prove-it.txt?v=1","prove-it-lyrics");
loadLyrics("lyrics/moonlight.txt?v=1","moonlight-lyrics");
loadLyrics("lyrics/sakuragi-sanka.txt?v=1","sakuragi-sanka-lyrics");
loadLyrics("lyrics/yume-kurage.txt?v=1","yume-kurage-lyrics");