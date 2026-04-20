import { test, expect } from "bun:test";
import { ProgressUI } from "../../src/cli/commands/init.js";

function capture(): { ui: ProgressUI; output: string[] } {
  const output: string[] = [];
  const ui = new ProgressUI((s) => output.push(s));
  return { ui, output };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("box() opens a correctly-sized title box", () => {
  const { ui, output } = capture();
  ui.box("Detecting environment");
  const line = stripAnsi(output[0] ?? "");
  // Total width should be 51 chars
  expect(line.trim()).toMatch(/^╭─ Detecting environment/);
  // Last visible char before newline should be ╮
  expect(line.replace("\n", "").slice(-1)).toBe("╮");
  expect(line.replace("\n", "").length).toBe(51);
});

test("closeBox() outputs a bottom border of correct width", () => {
  const { ui, output } = capture();
  ui.closeBox();
  const line = stripAnsi(output[0] ?? "").replace("\n", "");
  expect(line).toMatch(/^╰/);
  expect(line.slice(-1)).toBe("╯");
  expect(line.length).toBe(51);
});

test("detectionLine() renders ok with green tick", () => {
  const { ui, output } = capture();
  ui.detectionLine("TypeScript project", "tsconfig.json found", true);
  const line = stripAnsi(output[0] ?? "");
  expect(line).toContain("✓");
  expect(line).toContain("TypeScript project");
  expect(line.replace("\n", "").length).toBe(51);
});

test("detectionLine() renders miss with dim cross", () => {
  const { ui, output } = capture();
  ui.detectionLine("Claude Code", "", false);
  const line = stripAnsi(output[0] ?? "");
  expect(line).toContain("✗");
  expect(line).toContain("Claude Code");
});

test("step() renders a completed entry line fitting in the box", () => {
  const { ui, output } = capture();
  ui.step("Scanning source files", 47);
  const line = stripAnsi(output[0] ?? "").replace("\n", "");
  expect(line).toContain("◇");
  expect(line).toContain("Scanning source files");
  expect(line).toContain("47");
  expect(line.length).toBe(51);
});

test("step() renders a warn line when warn=true", () => {
  const { ui, output } = capture();
  ui.step("Git history", 0, true);
  const line = stripAnsi(output[0] ?? "");
  expect(line).toContain("⚠");
  expect(line).toContain("(failed)");
});

test("step() renders singular 'entry' when count is 1", () => {
  const { ui, output } = capture();
  ui.step("Some phase", 1);
  const line = stripAnsi(output[0] ?? "").replace("\n", "");
  expect(line).toContain("1 entry");
  expect(line).not.toContain("entries");
  expect(line.length).toBe(51);
});

test("step() warn line is 51 chars wide", () => {
  const { ui, output } = capture();
  ui.step("Git history", 0, true);
  const line = stripAnsi(output[0] ?? "").replace("\n", "");
  expect(line.length).toBe(51);
});

test("summary() outputs elapsed time and stats", () => {
  const { ui, output } = capture();
  ui.summary({ conventions: 5, decisions: 3, errors: 2, learnings: 8 }, 42);
  const text = output.join("");
  expect(text).toContain("42s");
  expect(text).toContain("5 conventions");
  expect(text).toContain("3 decisions");
  expect(text).toContain("2 error patterns");
  expect(text).toContain("8 learnings");
});
