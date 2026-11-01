/// <reference types="node" />
export interface AndroidDemoResult {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  probeResult?: unknown;
  ok: boolean;
}
export interface AndroidHeadless {
  available(): boolean;
  unavailableReason(): string | null;
  runDemo(html: string, opts?: {settleMs?: number; probe?: string}): Promise<AndroidDemoResult>;
  renderSvg(svg: string, opts?: {width?: number; height?: number}): Promise<Buffer>;
  renderPdfPages(pdfPath: string, pages: number[], opts?: {dpi?: number}): Promise<Array<{page: number; png: Buffer}>>;
}
export function createAndroidHeadless(options?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): AndroidHeadless;
export const androidHeadless: AndroidHeadless;
export default androidHeadless;
