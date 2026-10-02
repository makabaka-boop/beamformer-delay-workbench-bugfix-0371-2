/*
 * worker.js —— 音轨分析与混音 Worker
 *
 * 所有重活都在这里完成：
 *   {type:'load',    gen, outRate, tracks:[{samples,sampleRate,name}]}      装载新一批轨道
 *   {type:'analyze', gen, trims}   裁剪→重采样→整数延时相关性搜索
 *   {type:'mix',     gen, delays, gains, trims, sampleRate}  裁剪→重采样→逐样本混音 + WAV
 *
 * 输出采样率固定为第 1 路（基准路）原始采样率；各路裁剪区间按各自
 * 【原始】样本序号输入；延时统一按【输出】采样计。分析与合成共用同一
 * 条预处理链（prepareClip），保证自动延时与可听/下载内容来自同一份数据。
 *
 * 取消语义：每个请求携带主线程的代际号 gen；新请求到来立即抬升 Worker
 * 内部代际，旧分析/旧合成在下一个让出点检测到失配后终止（不回传旧结果）。
 * 回包一律携带【请求自身】的 gen（不是闸门当前代际），主线程再做一次
 * gen 校验，迟到结果既不会被“贴新号”接受，也不会替换当前试听。
 */
(function (global) {
  'use strict';

  if (typeof module !== 'object' || !module.exports) {
    // 浏览器 Worker 环境
    if (typeof importScripts === 'function') importScripts('core.js');
    var PcmCore = global.PcmCore;
  }

  function createWorkerApi(PcmCore) {
    let tracks = [];
    let outRate = 0;
    const guard = PcmCore.createEndpointGuard();

    /**
     * 分析 / 合成共用的预处理：逐轨按原始坐标裁剪并重采样到输出采样率。
     * maxOut 非空时只保留前 maxOut 个输出采样（分析窗口）。
     * 返回数组（可能含空片段）；被取消时返回 null。
     */
    async function prepareTracks(msg, signal, maxOut) {
      const rate = msg.sampleRate || outRate;
      if (!(rate > 0)) throw new Error('输出采样率未确定（基准路采样率无效）');
      const result = [];
      for (let i = 0; i < tracks.length; i++) {
        if (signal.cancelled) return null;
        const t = tracks[i];
        const trim = (msg.trims || [])[i];
        const clip = await PcmCore.prepareClip(
          t.samples, t.sampleRate, rate, trim, signal, maxOut
        );
        if (clip === null) return null;
        result.push(clip);
        // 轨间让出，使取消信号即时生效
        if (i < tracks.length - 1) await PcmCore.yieldToEventLoop();
      }
      return result;
    }

    async function handle(msg) {
      if (msg.type === 'load') {
        const token = guard.begin(msg.gen);
        outRate = (msg.tracks && msg.tracks[0] && msg.tracks[0].sampleRate) || msg.sampleRate || 0;
        if (!(outRate > 0)) throw new Error('基准路采样率无效');
        tracks = (msg.tracks || []).map(function (t) {
          // 未带采样率（测试同构输入）时按基准路处理
          const rate = t.sampleRate || outRate;
          if (!(rate > 0)) throw new Error('「' + (t.name || '?') + '」采样率无效');
          return { name: t.name, samples: t.samples, sampleRate: rate };
        });
        return { type: 'loaded', gen: msg.gen, count: tracks.length, sampleRate: outRate };
      }

      if (msg.type === 'analyze') {
        const token = guard.begin(msg.gen);
        if (!tracks.length) throw new Error('尚未装载音轨');

        // 分析预处理与合成完全一致：裁剪 → 重采样到输出采样率 → 取前 WINDOW
        const clips = await prepareTracks(msg, token.signal, PcmCore.WINDOW);
        if (clips === null) return null; // 已被新一代请求取消

        const ref = clips[0];
        const delays = [0];
        // 每一路分块搜索，块间让出事件循环以响应取消
        for (let i = 1; i < clips.length; i++) {
          if (token.signal.cancelled) return null;
          const other = clips[i];
          let bestD = -PcmCore.MAX_DELAY;
          let bestScore = PcmCore.correlationAt(ref, other, bestD);
          for (let d = -PcmCore.MAX_DELAY + 1; d <= PcmCore.MAX_DELAY; d++) {
            if (token.signal.cancelled) return null;
            const score = PcmCore.correlationAt(ref, other, d);
            if (PcmCore.isBetter(score, d, bestScore, bestD)) {
              bestScore = score;
              bestD = d;
            }
            // 每个延时候选都很小，8 个候选让一次即可兼顾取消响应与开销
            if (((d + PcmCore.MAX_DELAY) & 7) === 7) await PcmCore.yieldToEventLoop();
          }
          // 尾部让出后再查一次，避免旧分析在最后一个候选后漏检取消
          if (token.signal.cancelled) return null;
          delays.push(bestD);
        }
        // 回包携带请求代际；旧代迟到回复由主线程按代际丢弃
        return { type: 'analyzed', gen: msg.gen, delays: delays };
      }

      if (msg.type === 'mix') {
        const token = guard.begin(msg.gen);
        if (!tracks.length) throw new Error('尚未装载音轨');

        // 合成预处理与分析完全一致（不取窗口）：延时按输出采样计
        const sampleArrays = await prepareTracks(msg, token.signal);
        if (sampleArrays === null) return null; // 已被新一代请求取消

        const mixed = await PcmCore.mixTracks(
          sampleArrays,
          msg.delays.slice(),
          msg.gains.slice(),
          token.signal
        );
        if (mixed === null) return null; // 已被新一代请求取消
        const rate = msg.sampleRate || outRate;
        const wav = PcmCore.encodeWav(mixed, rate);
        return {
          type: 'mixed',
          gen: msg.gen,
          wav: wav,
          length: mixed.length,
          sampleRate: rate
        };
      }

      throw new Error('未知消息类型: ' + msg.type);
    }

    return { handle: handle };
  }

  if (typeof module === 'object' && module.exports) {
    // Node 测试环境
    module.exports = { createWorkerApi: createWorkerApi };
  } else {
    // 浏览器 Worker
    const api = createWorkerApi(PcmCore);
    global.onmessage = async function (e) {
      const result = await api.handle(e.data);
      if (result == null) return; // 被取消：不回传
      if (result.type === 'mixed' && result.wav) {
        // 转移所有权，避免拷贝
        global.postMessage(result, [result.wav]);
      } else {
        global.postMessage(result);
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
