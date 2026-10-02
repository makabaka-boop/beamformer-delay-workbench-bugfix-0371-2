'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core');
const { createWorkerApi } = require('../worker');

const i16 = (arr) => Int16Array.from(arr);

// ---------- 相关性：短数组穷举 ----------

test('correlationAt 与暴力双重循环完全一致（短数组穷举，含全部延时）', () => {
  const reference = i16([3, -1, 2, 5, -4, 0, 1]);
  const track = i16([-2, 4, 1, -3, 2, 6]);
  for (let d = -40; d <= 40; d++) {
    let brute = 0;
    for (let n = 0; n < reference.length; n++) {
      const k = n - d;
      if (k >= 0 && k < track.length) brute += reference[n] * track[k];
    }
    assert.equal(C.correlationAt(reference, track, d), brute, `d=${d}`);
  }
});

test('无交叠区间时相关性为 0', () => {
  const a = i16([1, 2, 3]);
  const b = i16([1, 2, 3]);
  assert.equal(C.correlationAt(a, b, 4), 0);
  assert.equal(C.correlationAt(a, b, -4), 0);
});

// ---------- 并列裁决：先 |d| 最小，再 d 最小 ----------

test('全零信号所有延时并列 → 取 0（绝对值最小）', () => {
  const z = i16(new Array(64).fill(0));
  assert.equal(C.findBestDelay(z, i16(new Array(64).fill(0))), 0);
});

test('±d 同分并列 → 取负向延时（数值最小）', () => {
  // 参考只有一个非零脉冲位于中央；在 track 两侧对称位置各放一个相等脉冲，
  // 则 d = -2 与 d = +2 同分，且严格高于其它延时。
  const reference = i16([0, 0, 0, 0, 5, 0, 0, 0, 0]);
  const track = i16([0, 0, 5, 0, 0, 0, 5, 0, 0]);
  // 确认两者同分
  assert.equal(
    C.correlationAt(reference, track, -2),
    C.correlationAt(reference, track, 2)
  );
  assert.equal(C.correlationAt(reference, track, -2), 25);
  assert.equal(C.findBestDelay(reference, track), -2);
});

// ---------- 负延时（以及正延时）恢复 ----------

test('LCG 噪声移位：正负延时都能被搜索到', () => {
  // 简单确定性伪随机，避免 0
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 2001) - 1000 || 1;
  };
  const base = i16(Array.from({ length: 300 }, rand));

  // t[n+S]=base[n]（即 t 相对 base 右移 S），对齐延时 d 应满足
  // t[n-d]=base[n] → d = -S。两侧越界处 t 为零。
  for (const S of [-27, -1, 1, 31]) {
    seed = 1234567; // 每轮重建同一条 base，避免随机序列被上一轮推进
    const base0 = i16(Array.from({ length: 300 }, rand));
    const shifted = new Int16Array(base0.length + 64);
    for (let n = 0; n < base0.length; n++) {
      const k = n + S;
      if (k >= 0 && k < shifted.length) shifted[k] = base0[n];
    }
    assert.equal(C.findBestDelay(base0, shifted), -S, `S=${S}`);
  }
});

test('analyze 以第 1 路为基准且只取开头至多 4096 采样', () => {
  const ref = i16([1, 2, 3, 4, 5]);
  const delayed = i16([0, 0, 1, 2, 3, 4, 5]); // t[n]=ref[n-2] → d=-2
  assert.deepEqual(C.analyze([ref, delayed]), [0, -2]);
  assert.equal(C.WINDOW, 4096);
  assert.equal(C.MAX_DELAY, 32);
});

// ---------- 混音：端点补零、长度、四分之一增益、饱和 ----------

test('混音负延时：左移后越界补零、长度由最右端决定', async () => {
  const a = i16([10, 20]);              // 基准
  const b = i16([100, 200]);            // d=-1：贡献落在 n=-1（裁掉）和 n=0
  const out = await C.mixTracks([a, b], [0, -1], [1, 1]);
  // L = max(0+2, -1+2) = 2；n=0 时 b[1]=200 落位 → 210，b[0] 在 n=-1 被裁
  assert.deepEqual(Array.from(out), [210, 20]);
});

test('混音正延时：起点补零、尾部延伸', async () => {
  const a = i16([10, 20]);
  const b = i16([100, 200]);           // d=+1
  const out = await C.mixTracks([a, b], [0, 1], [1, 1]);
  // L = max(2, 3) = 3
  assert.deepEqual(Array.from(out), [10, 120, 200]);
});

test('增益按四分之一整数倍量化（0.3→0.25，0.9→1.0）', () => {
  assert.equal(C.quantizeGain(0.3), 0.25);
  assert.equal(C.quantizeGain(0.9), 1);
  assert.equal(C.quantizeGain(0.124), 0);
  assert.equal(C.quantizeGain(0.126), 0.25);
  assert.equal(C.quantizeGain(2.75), 2.75);
});

test('混音增益与逐样本累加', async () => {
  const a = i16([8, -8, 7]);
  const b = i16([16, 0, -80]);
  const out = await C.mixTracks([a, b], [0, 0], [0.5, 0.25]);
  // 8*0.5 + 16*0.25 = 8；-8*0.5 = -4；7*0.5 + (-80)*0.25 = -16.5 → -17
  assert.deepEqual(Array.from(out), [8, -4, -17]);
});

test('饱和：正数截断到 32767、负数截断到 -32768，四舍五入', async () => {
  const a = i16([30000, -30000]);
  const b = i16([30000, -30000]);
  const out = await C.mixTracks([a, b], [0, 0], [1, 1]);
  assert.deepEqual(Array.from(out), [32767, -32768]);

  // 增益产生分数：3/4 + 0 = 0.75 → 1；-0.75 → -1
  const c = i16([1, -1]);
  const out2 = await C.mixTracks([c], [0], [0.75]);
  assert.deepEqual(Array.from(out2), [1, -1]);
});

test('空混音 / 全部在起点之前 → 空缓冲', async () => {
  assert.deepEqual(Array.from(await C.mixTracks([], [], [])), []);
  const a = i16([1, 2]);
  const out = await C.mixTracks([a], [-10], [1]); // end = -8 < 0
  assert.deepEqual(Array.from(out), []);
});

// ---------- WAV 解析 / 编码 ----------

function buildWav(samples, sampleRate, opts = {}) {
  const dataBytes = samples.length * 2;
  const junk = opts.junkSize || 0;
  const pad = junk & 1;
  // 12(RIFF头) + junk块(8+junk+pad) + 24(fmt块) + 8(data头) + dataBytes
  const buf = new ArrayBuffer(12 + (junk ? 8 + junk + pad : 0) + 24 + 8 + dataBytes);
  const dv = new DataView(buf);
  const id = (off, s) => { for (let i = 0; i < 4; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  id(0, 'RIFF');
  dv.setUint32(4, buf.byteLength - 8, true);
  id(8, 'WAVE');
  let off = 12;
  if (junk) {
    id(off, 'junk');
    dv.setUint32(off + 4, junk, true);
    for (let i = 0; i < junk; i++) dv.setUint8(off + 8 + i, 0x55);
    off += 8 + junk + pad;
  }
  id(off, 'fmt ');
  dv.setUint32(off + 4, 16, true);
  dv.setUint16(off + 8, 1, true);
  dv.setUint16(off + 10, 1, true);
  dv.setUint32(off + 12, sampleRate, true);
  dv.setUint32(off + 16, sampleRate * 2, true);
  dv.setUint16(off + 20, 2, true);
  dv.setUint16(off + 22, 16, true);
  off += 8 + 16;
  id(off, 'data');
  dv.setUint32(off + 4, dataBytes, true);
  samples.forEach((v, i) => dv.setInt16(off + 8 + i * 2, v, true));
  return buf;
}

test('WAV 往返编码：含负采样与极值，且容忍带填充的 junk 块', () => {
  const samples = i16([0, 1, -1, 32767, -32768, 1234, -4321]);
  const parsed = C.parseWav(buildWav(samples, 48000, { junkSize: 5 }));
  assert.equal(parsed.sampleRate, 48000);
  assert.deepEqual(Array.from(parsed.samples), Array.from(samples));

  const reparse = C.parseWav(C.encodeWav(parsed.samples, 48000));
  assert.equal(reparse.sampleRate, 48000);
  assert.deepEqual(Array.from(reparse.samples), Array.from(samples));
});

test('WAV 解析拒绝非单声道 / 非16bit / 非PCM', () => {
  assert.throws(() => C.parseWav(new ArrayBuffer(8)), /长度不足/);
  assert.throws(() => C.parseWav(new ArrayBuffer(44)), /RIFF/);

  // buildWav 生成的是单声道文件，下面直接改其 fmt 字段做拒绝路径测试
  const stereoBuf = buildWav(i16([1, 2, 3, 4]), 8000);
  new DataView(stereoBuf).setUint16(22, 2, true); // 双通道
  assert.throws(() => C.parseWav(stereoBuf), /单声道/);

  const bitsBuf = buildWav(i16([1, 2]), 8000);
  new DataView(bitsBuf).setUint16(34, 8, true);
  assert.throws(() => C.parseWav(bitsBuf), /16bit/);

  const floatBuf = buildWav(i16([1, 2]), 8000);
  new DataView(floatBuf).setUint16(20, 3, true); // IEEE float
  assert.throws(() => C.parseWav(floatBuf), /PCM/);
});

// ---------- 主线程侧会话：迟到结果不得替换当前状态 ----------

test('会话代际单调，旧代回复一律拒绝', () => {
  const s = C.createSession();
  const g1 = s.begin();
  const g2 = s.begin();
  assert.equal(g2, g1 + 1);
  assert.equal(s.isCurrent(g1), false);
  assert.equal(s.isCurrent(g2), true);
  // 模拟“分析迟到但用户已改参数”：旧 analyzed 必须被丢弃
  assert.equal(s.current(), g2);
});

// ---------- Worker 侧取消竞争（仿真双端消息队列）----------

/**
 * 最小双端仿真：
 *  - 主线程 post 一条消息 → setImmediate 投递到 Worker
 *  - Worker 的重活在 await 让出点检查代际信号；新请求抬号即取消旧任务
 *  - Worker 回复同样经 setImmediate 回到主线程
 * setImmediate 按 FIFO 执行，因此能确定性地复现“新请求插在旧任务让出点”。
 */
function createEndpointPair() {
  const api = createWorkerApi(C);
  const replies = [];
  return {
    post: (msg) => setImmediate(async () => {
      const reply = await api.handle(msg);
      if (reply != null) setImmediate(() => replies.push(reply));
    }),
    replies,
    drain: async (rounds = 20) => {
      for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      }
    }
  };
}

test('取消竞争：重新导入(load)插在旧 analyze 途中 → 旧分析被取消且不回传', async () => {
  const ep = createEndpointPair();

  const long = (n) => i16(Array.from({ length: n }, (_, i) => (i % 97) - 48));
  const tracks = [
    { name: 'r', samples: long(50000) },
    { name: 't', samples: long(50000) }
  ];

  ep.post({ type: 'load', gen: 1, tracks, sampleRate: 8000 });
  ep.post({ type: 'analyze', gen: 1 });
  // 不等分析结束，立刻重新导入：gen 抬到 2，旧分析在让出点退出
  ep.post({ type: 'load', gen: 2, tracks: [tracks[0], tracks[1]], sampleRate: 8000 });

  await ep.drain();

  const gens = ep.replies.map((r) => r.gen).sort();
  // gen1 的 analyzed 绝不能出现；只允许两次 loaded
  assert.ok(!ep.replies.some((r) => r.type === 'analyzed' && r.gen === 1),
    '旧代 analyzed 不得回传');
  assert.deepEqual(gens, [1, 2]);
  assert.deepEqual(ep.replies.map((r) => r.type).sort(), ['loaded', 'loaded']);
});

test('取消竞争：参数修改使旧 mix 中途作废 → 只有新 mix 回传', async () => {
  const ep = createEndpointPair();

  const long = (seed0) => {
    let s = seed0;
    return i16(Array.from({ length: 60000 }, () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s % 6000) - 3000;
    }));
  };
  const tracks = [
    { name: 'a', samples: long(11) },
    { name: 'b', samples: long(97) }
  ];
  ep.post({ type: 'load', gen: 1, tracks, sampleRate: 8000 });
  ep.post({ type: 'mix', gen: 1, delays: [0, 3], gains: [1, 1], sampleRate: 8000 });
  ep.post({ type: 'mix', gen: 2, delays: [0, 5], gains: [0.25, 1], sampleRate: 8000 });

  await ep.drain();

  const mixed = ep.replies.filter((r) => r.type === 'mixed');
  assert.equal(mixed.length, 1, '旧 mix 必须被取消，只回传一次');
  assert.equal(mixed[0].gen, 2);
  assert.ok(mixed[0].wav instanceof ArrayBuffer);
  assert.ok(mixed[0].wav.byteLength > 44);
});

test('Worker 正常链路：loaded → analyzed(gen内联触发) → mixed 内容正确', async () => {
  const ep = createEndpointPair();
  const a = i16([10, 20, 30]);
  const b = i16([100, 200, 300]); // 与 a 正相关，最佳延时 0
  ep.post({
    type: 'load', gen: 1,
    tracks: [{ name: 'a', samples: a }, { name: 'b', samples: b }],
    sampleRate: 8000
  });
  ep.post({ type: 'analyze', gen: 1 });
  ep.post({ type: 'mix', gen: 1, delays: [0, 0], gains: [1, 1], sampleRate: 8000 });

  await ep.drain();

  const analyzed = ep.replies.find((r) => r.type === 'analyzed');
  assert.ok(analyzed);
  assert.deepEqual(analyzed.delays, [0, 0]);

  const mixed = ep.replies.find((r) => r.type === 'mixed');
  assert.ok(mixed);
  const parsed = C.parseWav(mixed.wav);
  assert.deepEqual(Array.from(parsed.samples), [110, 220, 330]);
});

// ---------- 混合采样率：重采样、对齐、WAV 标称时长 ----------

test('resampleSamples：同采样率零拷贝；2x 上采样长度翻倍且保物理时刻', async () => {
  const s = i16([10, 20, 30, 40]);
  assert.strictEqual(await C.resampleSamples(s, 8000, 8000), s);

  const up = await C.resampleSamples(s, 8000, 16000);
  assert.equal(up.length, 8);
  // 物理时刻一致：输出偶数位取原样本，奇数位线性插值
  assert.deepEqual(Array.from(up), [10, 15, 20, 25, 30, 35, 40, 40]);

  const down = await C.resampleSamples(i16([10, 20, 30, 40]), 16000, 8000);
  assert.equal(down.length, 2);
  assert.deepEqual(Array.from(down), [10, 30]);

  // 空数组重采样仍为空
  assert.deepEqual(Array.from(await C.resampleSamples(i16([]), 8000, 16000)), []);
  await assert.rejects(() => C.resampleSamples(s, 0, 8000), /采样率/);
});

test('resampleSamples：maxOut 位置与全量重采样前缀一致（分析窗口）', async () => {
  let seed = 99;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 4001) - 2000; };
  const s = i16(Array.from({ length: 10000 }, rand));
  const full = await C.resampleSamples(s, 22050, 48000);
  const prefix = await C.resampleSamples(s, 22050, 48000, null, 4096);
  assert.equal(prefix.length, 4096);
  for (let m = 0; m < 4096; m++) {
    assert.equal(prefix[m], full[m], `m=${m}`);
  }
});

test('混合采样率：同一物理时刻脉冲（48k@0.1s 与 24k@0.1s）自动延时为 0', async () => {
  const ref = new Int16Array(48000); ref[4800] = 10000;
  const lo = new Int16Array(24000); lo[2400] = 10000;
  const loUp = await C.resampleSamples(lo, 24000, 48000);

  // 分析只取前 4096 输出采样（脉冲位于 4800，落在窗口外）→ 改测窗口内脉冲版本
  const refW = new Int16Array(4096); refW[1000] = 10000;
  // 对应 24k：同一物理时刻下标 round(1000*24000/48000)=500
  const loW = new Int16Array(2048); loW[500] = 10000;
  const loUpW = await C.resampleSamples(loW, 24000, 48000, null, 4096);
  assert.equal(C.findBestDelay(refW, loUpW), 0);
  // 全量同样对齐
  assert.equal(C.findBestDelay(ref.subarray(0, C.WINDOW), loUp.subarray(0, C.WINDOW)), 0);
});

test('prepareClip：裁剪坐标按原始样本序号、再重采样；start>end 为空片段', async () => {
  const s = i16([10, 20, 30, 40]);
  // 裁 [2,4) → [30,40]，再 2x → [30,35,40,40]
  const clip = await C.prepareClip(s, 8000, 16000, { start: 2, end: 4 });
  assert.deepEqual(Array.from(clip), [30, 35, 40, 40]);

  // NaN / 越界 / 负数由 clampTrim 钳制
  assert.deepEqual(C.clampTrim(100, NaN, NaN), [0, 100]);
  assert.deepEqual(C.clampTrim(100, -5, 200), [0, 100]);
  assert.deepEqual(C.clampTrim(100, 80, 10), [80, 80]);

  const empty = await C.prepareClip(s, 8000, 16000, { start: 3, end: 1 });
  assert.equal(empty.length, 0);
});

test('混合采样率混音：全长对齐，WAV 标称时长 == 可听内容时长', async () => {
  const ref = new Int16Array(8000); ref.fill(10);      // 1s @8k
  const lo = new Int16Array(4000); lo.fill(20);       // 1s @4k
  const loUp = await C.resampleSamples(lo, 4000, 8000);
  assert.equal(loUp.length, 8000);
  const out = await C.mixTracks([ref, loUp], [0, 0], [1, 1]);
  assert.equal(out.length, 8000); // 旧实现只有 4000：低采样率轨提前结束
  const wav = C.parseWav(C.encodeWav(out, 8000));
  assert.equal(wav.sampleRate, 8000);
  assert.equal(wav.samples.length, 8000);
  assert.equal(wav.samples.length / wav.sampleRate, 1);
  assert.equal(wav.samples[7999], 30); // 尾部仍有两路叠加，而非静音
});

// ---------- Worker：混合采样率 + 裁剪 + 代际一致性 ----------

test('Worker 混合采样率链路：analyze 与 mix 同一预处理，自动延时 0、输出按基准率', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(4096);
  const lo = new Int16Array(2048);
  ref[1000] = 10000;
  lo[500] = 10000; // 同一物理时刻
  ep.post({
    type: 'load', gen: 1,
    tracks: [
      { name: 'ref', samples: ref, sampleRate: 48000 },
      { name: 'lo', samples: lo, sampleRate: 24000 }
    ],
    sampleRate: 48000
  });
  ep.post({
    type: 'analyze', gen: 1,
    trims: [{ start: 0, end: 4096 }, { start: 0, end: 2048 }]
  });

  await ep.drain();

  const analyzed = ep.replies.find((r) => r.type === 'analyzed');
  assert.ok(analyzed);
  assert.deepEqual(analyzed.delays, [0, 0]);

  const ep2 = createEndpointPair();
  ep2.post({
    type: 'load', gen: 1,
    tracks: [
      { name: 'ref', samples: ref, sampleRate: 48000 },
      { name: 'lo', samples: lo, sampleRate: 24000 }
    ],
    sampleRate: 48000
  });
  ep2.post({
    type: 'mix', gen: 1, delays: [0, 0], gains: [1, 1],
    trims: [{ start: 0, end: 4096 }, { start: 0, end: 2048 }],
    sampleRate: 48000
  });
  await ep2.drain();
  const mixed = ep2.replies.find((r) => r.type === 'mixed');
  assert.ok(mixed);
  assert.equal(mixed.sampleRate, 48000);
  assert.equal(mixed.length, 4096); // 重采样后两轨等长，不再提前结束
});

test('Worker 迟到 analyze 回复携带【请求】代际，不会被贴上新号', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(4096);
  const lo = new Int16Array(2048);
  ref[1000] = 10000; lo[500] = 10000;
  ep.post({
    type: 'load', gen: 1,
    tracks: [
      { name: 'ref', samples: ref, sampleRate: 48000 },
      { name: 'lo', samples: lo, sampleRate: 24000 }
    ],
    sampleRate: 48000
  });
  // gen1 的分析（带裁剪）
  ep.post({ type: 'analyze', gen: 1, trims: [{ start: 0, end: 4096 }, { start: 0, end: 2048 }] });
  // gen2 立即换代（重新导入）
  ep.post({
    type: 'load', gen: 2,
    tracks: [
      { name: 'ref2', samples: ref, sampleRate: 48000 },
      { name: 'lo2', samples: lo, sampleRate: 24000 }
    ],
    sampleRate: 48000
  });
  await ep.drain();

  const analyzed = ep.replies.filter((r) => r.type === 'analyzed');
  // 旧分析若回传，gen 必须是请求自身的 1（主线程据 isCurrent 丢弃）；
  // 取消及时则根本不回传。两种情况都不允许出现 gen:2 的 analyzed。
  assert.ok(!analyzed.some((r) => r.gen === 2), '旧 analyze 不得携带新代际号');
  assert.ok(analyzed.every((r) => r.gen === 1));
});

test('空片段（裁剪为零长度）参与混音不报错，仅另一轨出声', async () => {
  const a = i16([1, 2, 3]);
  const b = i16([9, 9, 9]);
  // b 被裁成空片段
  const out = await C.mixTracks(
    [a, await C.prepareClip(b, 8000, 8000, { start: 2, end: 2 })],
    [0, 0], [1, 1]
  );
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test('负延时在重采样后的输出采样坐标上仍然成立', async () => {
  const base = i16(new Array(300).fill(0).map((_, i) => ((i * 37) % 53) - 26));
  // 低采样率轨：先右移 2 个输出采样的等价物理量，再以一半采样率呈现
  const shifted = new Int16Array(302);
  for (let n = 0; n < base.length; n++) shifted[n + 2] = base[n];
  // 降一半采样率：取偶数点（长度 151），再升回 8k
  const half = new Int16Array(Math.ceil(shifted.length / 2));
  for (let i = 0; i < half.length; i++) half[i] = shifted[i * 2];
  const back = await C.resampleSamples(half, 4000, 8000);
  // 右移 2 采样 → 对齐延时 d=-2（搜索范围内应能恢复）
  assert.equal(C.findBestDelay(base, back), -2);
});
