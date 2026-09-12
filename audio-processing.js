// Nettoyage du micro avant envoi aux pairs : passe-haut -> RNNoise (WASM, AudioWorklet)
// -> noise gate -> MediaStreamDestination. Tout tourne dans le navigateur de celui qui
// parle ; aucun serveur, rien ne change dans la topologie pair a pair.
//
// Si quoi que ce soit echoue (AudioWorklet absent, fichier manquant, contexte pas a
// 48 kHz), buildProcessedStream rejette et app.js envoie le micro brut comme avant.
//
// Interrupteur discret sans UI : localStorage.setItem("hisam-noise-suppression", "off").
(function () {
  const VENDOR_DIR = "vendor/web-noise-suppressor/";

  // ---- Reglages ----
  const HIGHPASS_HZ = 100;          // coupe le grave des chocs sur le bureau
  const GATE_OPEN_DB = -50;         // niveau RMS pour ouvrir le gate
  const GATE_CLOSE_DB = -60;        // niveau RMS sous lequel il se referme
  const GATE_HOLD_MS = 400;         // temps de maintien avant fermeture
  const REQUIRED_SAMPLE_RATE = 48000; // impose par RNNoise

  let libPromise = null;                 // Promise<{ lib, wasmBinary }>
  const workletsByContext = new WeakMap(); // AudioContext -> Promise<void>

  function vendorUrl(file) {
    return new URL(VENDOR_DIR + file, document.baseURI).href;
  }

  function isDisabled() {
    try {
      return localStorage.getItem("hisam-noise-suppression") === "off";
    } catch (err) {
      return false;
    }
  }

  // Bibliotheque ESM + binaire WASM, charges une seule fois pour toute la page.
  function loadLib() {
    if (!libPromise) {
      libPromise = (async () => {
        const lib = await import(vendorUrl("index.js"));
        const wasmBinary = await lib.loadRnnoise({
          url: vendorUrl("rnnoise.wasm"),
          simdUrl: vendorUrl("rnnoise_simd.wasm"),
        });
        return { lib, wasmBinary };
      })();
      libPromise.catch(() => { libPromise = null; });
    }
    return libPromise;
  }

  // Les processeurs AudioWorklet s'enregistrent par contexte.
  function loadWorklets(ctx) {
    let p = workletsByContext.get(ctx);
    if (!p) {
      p = Promise.all([
        ctx.audioWorklet.addModule(vendorUrl("rnnoise/workletProcessor.js")),
        ctx.audioWorklet.addModule(vendorUrl("noiseGate/workletProcessor.js")),
      ]).then(() => undefined);
      workletsByContext.set(ctx, p);
      p.catch(() => { workletsByContext.delete(ctx); });
    }
    return p;
  }

  async function buildProcessedStream(ctx, rawStream) {
    if (isDisabled()) {
      throw new Error("desactive (localStorage hisam-noise-suppression=off)");
    }
    if (!ctx || !ctx.audioWorklet) {
      throw new Error("AudioWorklet non supporte par ce navigateur");
    }
    // Safari (macOS) ne laisse demarrer un AudioContext que pendant un geste
    // utilisateur, et le repasse en "interrupted" des qu'une autre appli prend
    // l'audio. Le graphe se construirait sans la moindre erreur, mais
    // MediaStreamDestination ne produirait que du silence : les autres
    // n'entendraient plus rien du tout. Mieux vaut echouer ici et envoyer le
    // micro brut.
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (err) {
        // refus hors geste utilisateur : l'etat verifie juste apres tranche
      }
    }
    if (ctx.state !== "running") {
      throw new Error(`AudioContext ${ctx.state}, le flux traite serait muet`);
    }
    if (ctx.sampleRate !== REQUIRED_SAMPLE_RATE) {
      throw new Error(`AudioContext a ${ctx.sampleRate} Hz, RNNoise exige ${REQUIRED_SAMPLE_RATE}`);
    }

    const [{ lib, wasmBinary }] = await Promise.all([loadLib(), loadWorklets(ctx)]);

    const source = ctx.createMediaStreamSource(rawStream);

    // Mono des le premier noeud : RNNoise traite une voix, pas besoin de stereo.
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = HIGHPASS_HZ;
    highpass.channelCount = 1;
    highpass.channelCountMode = "explicit";

    const rnnoise = new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    const gate = new lib.NoiseGateWorkletNode(ctx, {
      openThreshold: GATE_OPEN_DB,
      closeThreshold: GATE_CLOSE_DB,
      holdMs: GATE_HOLD_MS,
      maxChannels: 1,
    });

    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;

    source.connect(highpass);
    highpass.connect(rnnoise);
    rnnoise.connect(gate);
    gate.connect(dest);

    let destroyed = false;
    return {
      stream: dest.stream,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        source.disconnect();
        highpass.disconnect();
        rnnoise.disconnect();
        rnnoise.destroy();
        gate.disconnect();
        dest.stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  window.HiSamAudio = { buildProcessedStream, REQUIRED_SAMPLE_RATE };
})();
