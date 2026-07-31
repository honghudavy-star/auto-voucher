import test from "node:test";
import assert from "node:assert/strict";

import {
  clampWorkflowCanvasNodeLeft,
  normalizeWorkflowCanvasEdgeX,
  resolveWorkflowCanvasEdgeMiddleX,
  workflowCanvasLaneForNode,
} from "../src/workflow-canvas.js";

test("workflow nodes stay inside their assigned source, process, or output lane", () => {
  assert.deepEqual(workflowCanvasLaneForNode("source-bank"), { start: 0, end: 0.28 });
  assert.deepEqual(workflowCanvasLaneForNode("process-rules"), { start: 0.28, end: 0.78 });
  assert.deepEqual(workflowCanvasLaneForNode("output-erp"), { start: 0.78, end: 1 });
  assert.deepEqual(workflowCanvasLaneForNode("renamed-node", "source"), { start: 0, end: 0.28 });

  const geometry = { surfaceWidth: 1000, nodeWidth: 190, padding: 12 };
  assert.equal(clampWorkflowCanvasNodeLeft({ ...geometry, nodeId: "source-bank", desiredLeft: 600 }), 78);
  assert.equal(clampWorkflowCanvasNodeLeft({ ...geometry, nodeId: "process-rules", desiredLeft: 0 }), 292);
  assert.equal(clampWorkflowCanvasNodeLeft({ ...geometry, nodeId: "process-rules", desiredLeft: 900 }), 578);
  assert.equal(clampWorkflowCanvasNodeLeft({ ...geometry, nodeId: "output-erp", desiredLeft: 200 }), 792);
  assert.equal(clampWorkflowCanvasNodeLeft({
    ...geometry,
    nodeId: "renamed-node",
    laneKind: "output",
    desiredLeft: 200,
  }), 792);
});

test("workflow edge bends remain between their connected nodes", () => {
  assert.equal(resolveWorkflowCanvasEdgeMiddleX({
    startX: 200,
    endX: 600,
    surfaceWidth: 1000,
  }), 400);
  assert.equal(resolveWorkflowCanvasEdgeMiddleX({
    startX: 200,
    endX: 600,
    surfaceWidth: 1000,
    storedNormalizedX: 0.9,
  }), 588);
  assert.equal(resolveWorkflowCanvasEdgeMiddleX({
    startX: 700,
    endX: 500,
    surfaceWidth: 1000,
    storedNormalizedX: 0.3,
  }), 512);
});

test("dragged workflow edge positions persist as bounded normalized coordinates", () => {
  assert.equal(normalizeWorkflowCanvasEdgeX(420, 1000), 0.42);
  assert.equal(normalizeWorkflowCanvasEdgeX(-20, 1000), 0);
  assert.equal(normalizeWorkflowCanvasEdgeX(1200, 1000), 1);
});
