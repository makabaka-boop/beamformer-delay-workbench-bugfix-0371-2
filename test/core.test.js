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

// ---------- 重采样：时长保持、插值、边界 ----------

test('重采样：同采样率返回等长拷贝（与输入解耦）', () => {
  const src = i16([1, -2, 3]);
  const out = C.resampleLinear(src, 48000, 48000);
  assert.deepEqual(Array.from(out), [1, -2, 3]);
  assert.notEqual(out.buffer, src.buffer);
});

test('重采样：2 倍上采样的长度与线性插值', () => {
  const out = C.resampleLinear(i16([0, 100, 200]), 8000, 16000);
  // outLen = round(3*2) = 6；源位置 0,.5,1,1.5,2,2.5（末尾无后继取 s0）
  assert.deepEqual(Array.from(out), [0, 50, 100, 150, 200, 200]);
  // 负采样同样插值
  const neg = C.resampleLinear(i16([-100, 100]), 8000, 16000);
  assert.deepEqual(Array.from(neg), [-100, 0, 100, 100]);
});

test('重采样：2:1 下采样按起点对齐抽取', () => {
  const out = C.resampleLinear(i16([10, 20, 30, 40]), 16000, 8000);
  assert.deepEqual(Array.from(out), [10, 30]);
});

test('重采样：物理时长保持（44100→48000），空输入与非法采样率', () => {
  const oneSec = new Int16Array(44100);       // 44.1kHz × 1s
  assert.equal(C.resampleLinear(oneSec, 44100, 48000).length, 48000);
  const oneSec48 = new Int16Array(48000);     // 48kHz × 1s
  assert.equal(C.resampleLinear(oneSec48, 48000, 44100).length, 44100);
  assert.equal(C.resampleLinear(new Int16Array(0), 8000, 16000).length, 0);
  assert.throws(() => C.resampleLinear(i16([1]), 0, 8000), /采样率/);
  assert.throws(() => C.resampleLinear(i16([1]), 8000, -1), /采样率/);
});

// ---------- 参数规范化：延时截断、裁剪区间 ----------

test('clampDelay：截断到 ±32 整数，非数值归零', () => {
  assert.equal(C.clampDelay(40), 32);
  assert.equal(C.clampDelay(-40), -32);
  assert.equal(C.clampDelay(3.6), 4);
  assert.equal(C.clampDelay(-3.6), -4);
  assert.equal(C.clampDelay(NaN), 0);
  assert.equal(C.clampDelay(undefined), 0);
});

test('clampTrim：负值/越界/倒置/非数值均归一化', () => {
  assert.deepEqual(C.clampTrim(2, 5, 10), { start: 2, end: 5 });
  assert.deepEqual(C.clampTrim(-5, 100, 10), { start: 0, end: 10 });
  assert.deepEqual(C.clampTrim(8, 3, 10), { start: 8, end: 8 }); // 倒置 → 空区间
  assert.deepEqual(C.clampTrim(0, -3, 10), { start: 0, end: 0 });
  assert.deepEqual(C.clampTrim(NaN, NaN, 10), { start: 0, end: 10 });
});

// ---------- 混合采样率：分析、混音、WAV 时长一致 ----------

test('混合采样率分析：同一时刻的脉冲在不同采样率下判为延时 0', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(4800);   // 48kHz，0.1s
  ref[2400] = 1000;                   // t = 0.05s
  const low = new Int16Array(2400);   // 24kHz，同样 0.1s
  low[1200] = 1000;                   // t = 0.05s（原始样本序号不同！）
  ep.post({
    type: 'load', gen: 1, sampleRate: 48000,
    tracks: [
      { name: 'r', samples: ref, sampleRate: 48000 },
      { name: 'l', samples: low, sampleRate: 24000 }
    ]
  });
  ep.post({ type: 'analyze', gen: 1 });
  await ep.drain();

  const analyzed = ep.replies.find((r) => r.type === 'analyzed');
  assert.ok(analyzed);
  assert.deepEqual(analyzed.delays, [0, 0]);
});

test('混合采样率混音：低采样率轨不提前结束，WAV 标称时长即实际时长', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(48000);        // 48kHz × 1s（基准）
  const low = new Int16Array(24000);        // 24kHz × 1s（相同时长）
  low[23999] = 500;                         // 末尾脉冲（t≈1s）
  ep.post({
    type: 'load', gen: 1, sampleRate: 48000,
    tracks: [
      { name: 'r', samples: ref, sampleRate: 48000 },
      { name: 'l', samples: low, sampleRate: 24000 }
    ]
  });
  ep.post({ type: 'mix', gen: 1, delays: [0, 0], gains: [1, 1], sampleRate: 48000 });
  await ep.drain();

  const mixed = ep.replies.find((r) => r.type === 'mixed');
  assert.ok(mixed);
  const parsed = C.parseWav(mixed.wav);
  assert.equal(parsed.sampleRate, 48000);
  // 输出覆盖完整 1s：低采样率轨重采样后延伸到输出末尾
  assert.equal(parsed.samples.length, 48000);
  assert.equal(parsed.samples[47998], 500);
  assert.equal(parsed.samples[47999], 500);
});

test('裁剪按原始样本坐标，裁剪后再重采样到输出采样率', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(4800);         // 48kHz 基准
  const low = new Int16Array(2400);         // 24kHz
  low[1200] = 700;                          // t = 0.05s
  ep.post({
    type: 'load', gen: 1, sampleRate: 48000,
    tracks: [
      { name: 'r', samples: ref, sampleRate: 48000 },
      { name: 'l', samples: low, sampleRate: 24000 }
    ]
  });
  // 裁掉 low 前 1200 个原始样本（0.05s），脉冲落在裁剪段起点
  ep.post({
    type: 'mix', gen: 1, delays: [0, 0], gains: [1, 1], sampleRate: 48000,
    trims: [{ start: 0, end: 4800 }, { start: 1200, end: 2400 }]
  });
  await ep.drain();

  const mixed = ep.replies.find((r) => r.type === 'mixed');
  const parsed = C.parseWav(mixed.wav);
  // 裁剪段 1200 个 24k 样本 → 2400 个 48k 输出样本；总长由基准决定
  assert.equal(parsed.samples.length, 4800);
  assert.equal(parsed.samples[0], 700);
});

test('空裁剪片段：该轨无任何贡献', async () => {
  const ep = createEndpointPair();
  ep.post({
    type: 'load', gen: 1, sampleRate: 8000,
    tracks: [
      { name: 'a', samples: i16([10, 20, 30]), sampleRate: 8000 },
      { name: 'b', samples: i16([100, 200, 300]), sampleRate: 8000 }
    ]
  });
  ep.post({
    type: 'mix', gen: 1, delays: [0, 0], gains: [1, 1], sampleRate: 8000,
    trims: [{ start: 0, end: 3 }, { start: 2, end: 2 }] // b 为空区间
  });
  await ep.drain();

  const mixed = ep.replies.find((r) => r.type === 'mixed');
  const parsed = C.parseWav(mixed.wav);
  assert.deepEqual(Array.from(parsed.samples), [10, 20, 30]);
});

test('负延时与重采样叠加：在输出采样域左移', async () => {
  const ep = createEndpointPair();
  const ref = new Int16Array(200);          // 48kHz 基准（全零）
  const low = new Int16Array(100);          // 24kHz
  low[10] = 300;                            // 重采样到 48k 后位于输出样本 20
  ep.post({
    type: 'load', gen: 1, sampleRate: 48000,
    tracks: [
      { name: 'r', samples: ref, sampleRate: 48000 },
      { name: 'l', samples: low, sampleRate: 24000 }
    ]
  });
  ep.post({ type: 'mix', gen: 1, delays: [0, -5], gains: [1, 1], sampleRate: 48000 });
  await ep.drain();

  const mixed = ep.replies.find((r) => r.type === 'mixed');
  const parsed = C.parseWav(mixed.wav);
  assert.equal(parsed.samples.length, 200);
  assert.equal(parsed.samples[15], 300); // 20 + (−5)
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
