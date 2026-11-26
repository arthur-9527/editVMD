/**
 * 视频捕捉 → 动作 的播放 / 持久化回归测试。
 *
 * 钉住三条关键不变式：
 *   1. `oneShotEndFrame` 取「动作末帧 / 视频末帧」的较小者（播完自动停）；
 *   2. 视频时长换算成 30fps 帧数时，优先后端记录、其次元素 duration；
 *   3. 动作库条目的 `sourceVideoId` 必须能随工程序列化往返 ——
 *      丢了它，刷新后视频窗口就找不到「这段视频对应哪条动作」，
 *      也会把同一视频的动作重复导入（源需求 1 / 2 的核心）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyProject } from "../src/doc/project.ts";
import { emptyClip } from "../src/doc/types.ts";
import { decodeProject, encodeProject } from "../src/io/serialize.ts";
import { oneShotEndFrame, videoFrameCount, VIDEO_FPS } from "../src/lib/video-playback.ts";

test("一次性播放：视频比动作短 → 停在视频末帧", () => {
  // 动作块 [100, 260)（160 帧），视频 4s = 120 帧 → 视频末帧 = 100+120-1 = 219
  assert.equal(oneShotEndFrame(100, 260, 120), 219);
});

test("一次性播放：动作比视频短 → 停在动作末帧", () => {
  // 动作块 [0, 91)（末帧 90），视频 10s = 300 帧
  assert.equal(oneShotEndFrame(0, 91, 300), 90);
});

test("一次性播放：不知道视频时长 → 按动作长度播", () => {
  assert.equal(oneShotEndFrame(50, 81, null), 80);
});

test("一次性播放：编排前面已有内容时，视频长度是相对块起点的", () => {
  // 块从 500 开始，动作 100 帧，视频 10 帧 → 末帧 = 509（不是 9/499）
  assert.equal(oneShotEndFrame(500, 600, 10), 509);
});

test("视频帧数：优先用后端记录的时长", () => {
  assert.equal(videoFrameCount(4000, 99), 4 * VIDEO_FPS);
});

test("视频帧数：后端没记时长时读元素 duration", () => {
  assert.equal(videoFrameCount(null, 2.5), Math.round(2.5 * VIDEO_FPS));
});

test("视频帧数：两边都没有 → null（按动作长度播）", () => {
  assert.equal(videoFrameCount(null, null), null);
  assert.equal(videoFrameCount(0, Number.NaN), null);
});

test("sourceVideoId：随工程序列化往返保留", () => {
  const project = emptyProject();
  const withLib = {
    ...project,
    library: [
      {
        id: "clip-1",
        name: "视频动作",
        clip: emptyClip(),
        sourceVideoId: "video-1",
      },
    ],
  };
  const round = decodeProject(encodeProject(withLib));
  assert.equal(round.library.length, 1);
  assert.equal(round.library[0].sourceVideoId, "video-1");
});
