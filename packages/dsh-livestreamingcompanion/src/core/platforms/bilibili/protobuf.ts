/**
 * B 站的 protobuf 读取器现在和抖音共用（抖音整帧都是 protobuf）。
 * 这里保留旧路径，免得 biliDecode 和测试一起改。
 */

export { pbChild, pbId, pbNumber, pbString, readPb, type PbMessage } from '../pb';
