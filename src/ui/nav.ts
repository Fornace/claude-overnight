// Arrow-key navigation across the live frame.
//
// The display is conceptually a list of sections — agent table, detail,
// merges, events (run phase) or objective/status/lastWave/planner (steering
// phase). Navigation moves a focus cursor (section, row) through that list
// and is the basis for the right-arrow "drill into agent" gesture and the
// detail panel's open/close behavior.

import type { Swarm } from "../swarm/swarm.js";
import type { AgentState } from "../core/types.js";
import { allTurns, cycleFocused } from "../core/turns.js";
import type { SteeringContext, SteeringEvent } from "./types.js";

export interface NavState {
  focusSection: number;
  focusRow: number;
  scrollOffset: number;
}

export function newNavState(): NavState {
  return { focusSection: 0, focusRow: 0, scrollOffset: 0 };
}

interface SectionDescriptor {
  title: string;
  rowCount: number;
  highlightKeyForRow: (row: number) => string | undefined;
}

/** Describes "where am I focused" inputs and outputs without coupling to
 *  RunDisplay internals. The navigator pulls phase data through this shape so
 *  the same code drives both the run and steering frames. */
export interface NavContext {
  swarm: Swarm | undefined;
  steeringActive: boolean;
  steeringEvents: SteeringEvent[];
  steeringContext: SteeringContext | undefined;
  selectedAgentId: number | undefined;
  selectAgent(id: number): void;
  clearSelectedAgent(): void;
}

/** Agents shown in the table = all running + the tail of finished. */
export function getVisibleAgents(swarm: Swarm | undefined): AgentState[] {
  if (!swarm) return [];
  const running = swarm.agents.filter(a => a.status === "running");
  const finished = swarm.agents.filter(a => a.status !== "running");
  const showFinished = finished.slice(-Math.max(2, 12 - running.length));
  return [...running, ...showFinished];
}

/** Discover sections from the current phase for navigation boundaries. */
export function getSections(ctx: NavContext): SectionDescriptor[] {
  const sections: SectionDescriptor[] = [];

  if (ctx.swarm) {
    const show = getVisibleAgents(ctx.swarm);
    sections.push({
      title: "Agents",
      rowCount: show.length,
      highlightKeyForRow: (row: number) => show[row]?.id != null ? `agent-${show[row].id}` : undefined,
    });
    if (ctx.selectedAgentId != null) {
      sections.push({ title: "Detail", rowCount: 1, highlightKeyForRow: () => "detail" });
    }
    if (ctx.swarm.mergeResults.length > 0) {
      sections.push({
        title: "Merges",
        rowCount: ctx.swarm.mergeResults.length,
        highlightKeyForRow: (row: number) => `merge-${row}`,
      });
    }
    sections.push({
      title: "Events",
      rowCount: Math.min(12, ctx.swarm.logs.length),
      highlightKeyForRow: (row: number) => `event-${row}`,
    });
  } else if (ctx.steeringActive) {
    if (ctx.steeringContext?.objective) {
      sections.push({ title: "Objective", rowCount: 1, highlightKeyForRow: () => "objective" });
    }
    if (ctx.steeringContext?.status) {
      sections.push({ title: "Status", rowCount: 1, highlightKeyForRow: () => "status" });
    }
    if (ctx.steeringContext?.lastWave) {
      sections.push({
        title: "LastWave",
        rowCount: Math.min(6, ctx.steeringContext.lastWave.tasks.length + 1),
        highlightKeyForRow: (row: number) => `wave-task-${row}`,
      });
    }
    sections.push({
      title: "PlannerActivity",
      rowCount: Math.min(15, ctx.steeringEvents.length),
      highlightKeyForRow: (row: number) => `steer-event-${row}`,
    });
    sections.push({ title: "StatusLine", rowCount: 1, highlightKeyForRow: () => "status-line" });
  }

  if (sections.length === 0) {
    sections.push({ title: "Content", rowCount: 1, highlightKeyForRow: () => "content" });
  }
  return sections;
}

export function clampNavState(nav: NavState, sections: SectionDescriptor[]): void {
  nav.focusSection = Math.min(Math.max(0, nav.focusSection), sections.length - 1);
  const s = sections[nav.focusSection];
  if (s) {
    nav.focusRow = Math.min(Math.max(0, nav.focusRow), Math.max(0, s.rowCount - 1));
  }
}

/** Move the focus cursor in `direction`. Returns true if anything changed.
 *  Side-effects on the agent selection happen via `ctx.selectAgent` /
 *  `ctx.clearSelectedAgent` so this module never mutates RunDisplay state
 *  directly. */
export function navigate(
  ctx: NavContext,
  nav: NavState,
  direction: "up" | "down" | "left" | "right" | "enter",
): boolean {
  const sections = getSections(ctx);
  const section = sections[Math.min(nav.focusSection, sections.length - 1)];
  let changed = false;

  switch (direction) {
    case "up":
      if (nav.focusRow > 0) {
        nav.focusRow--;
        nav.scrollOffset = Math.max(0, nav.scrollOffset - 1);
        changed = true;
      } else if (nav.focusSection > 0) {
        nav.focusSection--;
        const prevSection = sections[nav.focusSection];
        nav.focusRow = Math.max(0, prevSection.rowCount - 1);
        changed = true;
      }
      break;
    case "down":
      if (nav.focusRow < section.rowCount - 1) {
        nav.focusRow++;
        changed = true;
      } else if (nav.focusSection < sections.length - 1) {
        nav.focusSection++;
        nav.focusRow = 0;
        changed = true;
      }
      break;
    case "left":
      if (ctx.selectedAgentId != null) {
        ctx.clearSelectedAgent();
        changed = true;
      } else if (allTurns().length > 1) {
        cycleFocused(-1);
        changed = true;
      } else if (nav.focusSection > 0) {
        nav.focusSection--;
        nav.focusRow = 0;
        changed = true;
      }
      break;
    case "right":
      if (ctx.swarm && ctx.selectedAgentId == null) {
        const agents = getVisibleAgents(ctx.swarm);
        const agent = agents[nav.focusRow];
        if (agent && agent.status === "running") {
          ctx.selectAgent(agent.id);
          changed = true;
        }
      } else if (allTurns().length > 1) {
        cycleFocused(1);
        changed = true;
      } else if (nav.focusSection < sections.length - 1) {
        nav.focusSection++;
        nav.focusRow = 0;
        changed = true;
      }
      break;
    case "enter":
      if (ctx.swarm) {
        const agents = getVisibleAgents(ctx.swarm);
        const agent = agents[nav.focusRow];
        if (agent) {
          if (ctx.selectedAgentId === agent.id) ctx.clearSelectedAgent();
          else ctx.selectAgent(agent.id);
          changed = true;
        }
      }
      break;
  }

  clampNavState(nav, sections);
  return changed;
}

/** Returns the unique highlight key for the currently focused row. */
export function highlightKey(ctx: NavContext, nav: NavState): string | undefined {
  const sections = getSections(ctx);
  const section = sections[Math.min(nav.focusSection, sections.length - 1)];
  return section?.highlightKeyForRow?.(nav.focusRow);
}
