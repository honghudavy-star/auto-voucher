export const WORKFLOW_CANVAS_LANES = Object.freeze({
  source: Object.freeze({ start: 0, end: 0.28 }),
  process: Object.freeze({ start: 0.28, end: 0.78 }),
  output: Object.freeze({ start: 0.78, end: 1 }),
});

export function workflowCanvasLaneForNode(nodeId, laneKind) {
  if (laneKind && WORKFLOW_CANVAS_LANES[laneKind]) return WORKFLOW_CANVAS_LANES[laneKind];
  if (String(nodeId).startsWith("source-")) return WORKFLOW_CANVAS_LANES.source;
  if (String(nodeId).startsWith("output-")) return WORKFLOW_CANVAS_LANES.output;
  return WORKFLOW_CANVAS_LANES.process;
}

export function clampWorkflowCanvasNodeLeft({
  nodeId,
  laneKind,
  desiredLeft,
  surfaceWidth,
  nodeWidth,
  padding = 12,
}) {
  const lane = workflowCanvasLaneForNode(nodeId, laneKind);
  const laneStart = (surfaceWidth * lane.start) + padding;
  const laneEnd = (surfaceWidth * lane.end) - padding;
  const maximumLeft = Math.max(laneStart, laneEnd - nodeWidth);
  return Math.min(maximumLeft, Math.max(laneStart, desiredLeft));
}

export function resolveWorkflowCanvasEdgeMiddleX({
  startX,
  endX,
  surfaceWidth,
  storedNormalizedX,
  padding = 12,
}) {
  const defaultMiddleX = startX + ((endX - startX) / 2);
  const minimumX = Math.min(startX, endX) + padding;
  const maximumX = Math.max(startX, endX) - padding;
  if (maximumX <= minimumX) return defaultMiddleX;
  const storedX = Number(storedNormalizedX) * surfaceWidth;
  const desiredX = Number.isFinite(storedX) ? storedX : defaultMiddleX;
  return Math.min(maximumX, Math.max(minimumX, desiredX));
}

export function normalizeWorkflowCanvasEdgeX(middleX, surfaceWidth) {
  if (!Number.isFinite(middleX) || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return 0.5;
  return Math.min(1, Math.max(0, middleX / surfaceWidth));
}
