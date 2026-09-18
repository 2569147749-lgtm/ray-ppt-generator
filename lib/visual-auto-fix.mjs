function safeId(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

function candidateKey(candidate) {
  return [candidate.slide, candidate.itemId ?? "", candidate.target].join("\u0000");
}

function unresolved(capture, finding, reason) {
  return {
    capture: capture.id,
    slide: capture.slide,
    code: finding.code,
    reason,
    selectors: finding.selectors ?? []
  };
}

function plannedFontSize(candidate) {
  const values = [
    candidate.fontSize,
    candidate.minFontSize,
    candidate.clientWidth,
    candidate.clientHeight,
    candidate.scrollWidth,
    candidate.scrollHeight
  ].map(Number);
  if (
    values.some((value) => !Number.isFinite(value) || value <= 0) ||
    candidate.scrollWidth <= candidate.clientWidth &&
      candidate.scrollHeight <= candidate.clientHeight
  ) {
    return null;
  }
  const scale = Math.min(
    candidate.clientWidth / candidate.scrollWidth,
    candidate.clientHeight / candidate.scrollHeight
  );
  const fontSize = Math.floor(candidate.fontSize * scale * 0.98 * 100) / 100;
  if (fontSize >= candidate.fontSize || fontSize < candidate.minFontSize) {
    return null;
  }
  return fontSize;
}

export function planVisualAutoFix(report) {
  const grouped = new Map();
  const blockedKeys = new Set();
  const unresolvedFindings = [
    ...(report.fontContinuity?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) =>
        unresolved(
          { id: null, slide: finding.slide },
          finding,
          "unsupported-font-continuity-finding"
        )
      ),
    ...(report.styleConsistency?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) =>
        unresolved(
          { id: null, slide: finding.slide },
          finding,
          "unsupported-style-finding"
        )
      ),
    ...(report.visualQuality?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) =>
        unresolved(
          { id: null, slide: finding.slide },
          finding,
          "unsupported-quality-finding"
        )
      ),
    ...(report.semanticEmphasis?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) =>
        unresolved(
          { id: null, slide: finding.slide },
          finding,
          "unsupported-semantic-emphasis-finding"
        )
      )
  ];

  for (const capture of report.captures ?? []) {
    for (const finding of capture.findings ?? []) {
      if (finding.severity !== "blocker") continue;
      if (finding.code !== "text-overflow" || finding.autoFix?.command !== "fit-text") {
        unresolvedFindings.push(unresolved(capture, finding, "unsupported-finding"));
        continue;
      }
      const candidate = finding.autoFix;
      const key = candidateKey(candidate);
      if (capture.visualDiff && capture.visualDiff.planned === false) {
        blockedKeys.add(key);
        unresolvedFindings.push(
          unresolved(capture, finding, "unplanned-revision-slide")
        );
        continue;
      }
      const fontSize = plannedFontSize(candidate);
      if (fontSize === null) {
        blockedKeys.add(key);
        unresolvedFindings.push(
          unresolved(capture, finding, "below-minimum-font-size")
        );
        continue;
      }
      const current = grouped.get(key);
      if (!current || fontSize < current.fontSize) {
        grouped.set(key, {
          candidate,
          fontSize
        });
      }
    }
  }

  const commands = [...grouped.entries()]
    .filter(([key]) => !blockedKeys.has(key))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, { candidate, fontSize }]) => {
      const item = candidate.itemId ? `-${safeId(candidate.itemId)}` : "";
      return {
        id: `visual-fit-${safeId(candidate.slide)}${item}-${safeId(candidate.target)}`,
        command: "fit-text",
        slide: candidate.slide,
        target: candidate.target,
        itemId: candidate.itemId ?? null,
        fontSize,
        minFontSize: candidate.minFontSize
      };
    });

  return {
    commands,
    unresolved: unresolvedFindings
  };
}

export function fingerprintVisualFixCommands(commands) {
  return JSON.stringify(
    [...commands]
      .map((command) => ({
        command: command.command,
        slide: command.slide,
        itemId: command.itemId ?? null,
        target: command.target,
        fontSize: command.fontSize,
        minFontSize: command.minFontSize
      }))
      .sort((first, second) =>
        JSON.stringify(first).localeCompare(JSON.stringify(second))
      )
  );
}

export async function runVisualAutoFixLoop({
  maxRounds = 3,
  audit,
  apply
}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error("maxRounds must be a positive integer.");
  }
  if (typeof audit !== "function" || typeof apply !== "function") {
    throw new Error("Visual auto-fix loop requires audit and apply functions.");
  }

  const rounds = [];
  const fingerprints = new Set();
  let repairsApplied = 0;

  while (true) {
    const round = {
      index: rounds.length + 1,
      report: null,
      plan: null,
      fingerprint: null,
      applied: false
    };
    rounds.push(round);

    try {
      round.report = await audit({ round: round.index, repairsApplied });
    } catch (error) {
      round.error = error.message;
      return {
        status: "failed",
        stopReason: "audit-failed",
        repairsApplied,
        rounds
      };
    }

    if (round.report.capturePassed) {
      return {
        status: repairsApplied > 0 ? "repaired" : "clean",
        stopReason: "capture-passed",
        repairsApplied,
        rounds
      };
    }

    round.plan = planVisualAutoFix(round.report);
    if (round.plan.commands.length === 0) {
      return {
        status: "unresolved",
        stopReason: "no-eligible-repair",
        repairsApplied,
        rounds
      };
    }
    if (repairsApplied >= maxRounds) {
      return {
        status: "unresolved",
        stopReason: "max-rounds",
        repairsApplied,
        rounds
      };
    }

    round.fingerprint = fingerprintVisualFixCommands(round.plan.commands);
    if (fingerprints.has(round.fingerprint)) {
      return {
        status: "unresolved",
        stopReason: "repeated-repair",
        repairsApplied,
        rounds
      };
    }
    fingerprints.add(round.fingerprint);

    try {
      await apply(round.plan.commands, {
        round: round.index,
        repairsApplied
      });
      round.applied = true;
      repairsApplied += 1;
    } catch (error) {
      round.error = error.message;
      return {
        status: "failed",
        stopReason: "apply-failed",
        repairsApplied,
        rounds
      };
    }
  }
}
