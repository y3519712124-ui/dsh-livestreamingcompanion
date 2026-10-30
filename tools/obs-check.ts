// 开发工具：打开（或连上）OBS，按 dsh-livestreamingcompanion 的推流配置设好，截一张节目画面看清晰度。不推流。
// 用法：node tools/obs-check.mjs <舞台地址> <截图输出.png>
import { writeFileSync } from 'node:fs';
import { connectObs, prepareObs } from '../packages/dsh-livestreamingcompanion/src/body/obs';

const [stageUrl, out] = process.argv.slice(2);
const obs = await connectObs(true);
try {
  await prepareObs(obs, stageUrl);
  await new Promise((r) => setTimeout(r, 6000)); // 等舞台页加载、动画跑起来
  const video = await obs.call('GetVideoSettings');
  const { currentProfileName } = await obs.call('GetProfileList');
  const { currentSceneCollectionName } = await obs.call('GetSceneCollectionList');
  const { inputs } = await obs.call('GetInputList');
  console.log(JSON.stringify({ profile: currentProfileName, collection: currentSceneCollectionName, video, inputs: inputs.map((i: any) => `${i.inputName}(${i.inputKind})`) }));
  const shot = await obs.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: '直播', imageFormat: 'png', imageWidth: 1920, imageHeight: 1080 });
  writeFileSync(out, Buffer.from(shot.imageData.split(',')[1], 'base64'));
  console.log('screenshot', out);
} finally {
  obs.close();
}
