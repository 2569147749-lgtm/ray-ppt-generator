import {
  readImageState,
  readItemText,
  readItemState,
  readSemanticText,
  readSlideOrder,
  readSlideState
} from "./deck-dom.mjs";

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function automaticAssertions(change) {
  switch (change.command) {
    case "set-text":
      return [
        {
          type: "text-equals",
          slide: change.slide,
          target: change.target,
          expected: change.value
        }
      ];
    case "add-item":
      return [
        {
          type: "item-exists",
          slide: change.slide,
          target: change.target,
          itemId: change.item?.id
        },
        {
          type: "item-text-equals",
          slide: change.slide,
          target: change.target,
          itemId: change.item?.id,
          role: "item-title",
          expected: change.item?.title
        },
        {
          type: "item-text-equals",
          slide: change.slide,
          target: change.target,
          itemId: change.item?.id,
          role: "item-body",
          expected: change.item?.body
        },
        {
          type: "sequential-numbering",
          slide: change.slide,
          target: change.target
        }
      ];
    case "remove-item":
      return [
        {
          type: "item-absent",
          slide: change.slide,
          target: change.target,
          itemId: change.itemId
        },
        {
          type: "sequential-numbering",
          slide: change.slide,
          target: change.target
        }
      ];
    case "replace-image":
      return [
        {
          type: "image-src-equals",
          slide: change.slide,
          target: change.target,
          expected: change.src
        },
        {
          type: "image-alt-equals",
          slide: change.slide,
          target: change.target,
          expected: change.alt
        },
        {
          type: "image-layout-equals",
          slide: change.slide,
          target: change.target,
          expected: change.imageLayout
        },
        {
          type: "image-dimensions-equal",
          slide: change.slide,
          target: change.target,
          expected: {
            width: change.imageWidth,
            height: change.imageHeight
          }
        },
        {
          type: "image-fit-equals",
          slide: change.slide,
          target: change.target,
          expected: change.fit
        }
      ];
    case "add-slide":
      return [
        {
          type: "slide-exists",
          slide: change.targets?.[0]
        },
        {
          type: "slide-after",
          slide: change.targets?.[0],
          expected: change.after
        },
        {
          type: "slide-layout-equals",
          slide: change.targets?.[0],
          expected: change.reviewedLayout
        },
        {
          type: "slide-attribute-equals",
          slide: change.targets?.[0],
          target: "data-layout-treatment",
          expected: change.layoutTreatment
        }
      ];
    case "delete-slide":
      return [
        {
          type: "slide-absent",
          slide: change.slide
        }
      ];
    case "move-slide":
      return [
        {
          type: "slide-after",
          slide: change.slide,
          expected: change.after
        }
      ];
    case "split-slide":
      return [
        {
          type: "slide-exists",
          slide: change.slide
        },
        {
          type: "slide-exists",
          slide: change.newSlide
        },
        {
          type: "slide-after",
          slide: change.newSlide,
          expected: change.slide
        },
        ...(change.moveItemIds ?? []).flatMap((itemId) => [
          {
            type: "item-absent",
            slide: change.slide,
            target: change.target,
            itemId
          },
          {
            type: "item-exists",
            slide: change.newSlide,
            target: change.target,
            itemId
          }
        ]),
        {
          type: "sequential-numbering",
          slide: change.slide,
          target: change.target
        },
        {
          type: "sequential-numbering",
          slide: change.newSlide,
          target: change.target
        }
      ];
    case "custom-edit":
      if (!Array.isArray(change.assertions) || change.assertions.length === 0) {
        throw new Error(`Change ${change.id} custom-edit requires explicit assertions.`);
      }
      return [];
    default:
      throw new Error(`Change ${change.id} uses unsupported command "${change.command}".`);
  }
}

function passedResult(assertion, actual, expected = assertion.expected) {
  return {
    ...assertion,
    expected,
    actual,
    passed: true
  };
}

function failedResult(assertion, actual, expected, message) {
  return {
    ...assertion,
    expected,
    actual,
    passed: false,
    message
  };
}

function evaluateAssertion(html, assertion) {
  const slideOrder = readSlideOrder(html);

  try {
    switch (assertion.type) {
      case "text-equals": {
        const actual = readSemanticText(html, assertion.slide, assertion.target);
        const expected = normalizedText(assertion.expected);
        return normalizedText(actual) === expected
          ? passedResult(assertion, actual, expected)
          : failedResult(
              assertion,
              actual,
              expected,
              `Expected ${assertion.slide}.${assertion.target} to equal "${expected}".`
            );
      }
      case "text-includes": {
        const actual = readSemanticText(html, assertion.slide, assertion.target);
        const expected = normalizedText(assertion.expected);
        return normalizedText(actual).includes(expected)
          ? passedResult(assertion, actual, expected)
          : failedResult(
              assertion,
              actual,
              expected,
              `Expected ${assertion.slide}.${assertion.target} to include "${expected}".`
            );
      }
      case "item-count": {
        const actual = readItemState(
          html,
          assertion.slide,
          assertion.target
        ).count;
        return actual === assertion.expected
          ? passedResult(assertion, actual)
          : failedResult(
              assertion,
              actual,
              assertion.expected,
              `Expected ${assertion.slide}.${assertion.target} item count ${assertion.expected}.`
            );
      }
      case "item-text-equals": {
        const actual = readItemText(
          html,
          assertion.slide,
          assertion.target,
          assertion.itemId,
          assertion.role
        );
        const expected = normalizedText(assertion.expected);
        return normalizedText(actual) === expected
          ? passedResult(assertion, actual, expected)
          : failedResult(
              assertion,
              actual,
              expected,
              `Expected item "${assertion.itemId}" ${assertion.role} to equal "${expected}".`
            );
      }
      case "item-exists":
      case "item-absent": {
        const exists = readItemState(
          html,
          assertion.slide,
          assertion.target
        ).ids.includes(assertion.itemId);
        const expected = assertion.type === "item-exists";
        return exists === expected
          ? passedResult(assertion, exists, expected)
          : failedResult(
              assertion,
              exists,
              expected,
              `Expected item "${assertion.itemId}" to be ${expected ? "present" : "absent"}.`
            );
      }
      case "sequential-numbering": {
        const state = readItemState(html, assertion.slide, assertion.target);
        const expected = state.ids.map((_, index) =>
          String(index + 1).padStart(2, "0")
        );
        const passed =
          state.numbers.length === expected.length &&
          state.numbers.every((number, index) => number === expected[index]);
        return passed
          ? passedResult(assertion, state.numbers, expected)
          : failedResult(
              assertion,
              state.numbers,
              expected,
              `Expected sequential numbering on ${assertion.slide}.${assertion.target}.`
            );
      }
      case "image-src-equals":
      case "image-alt-equals": {
        const state = readImageState(html, assertion.slide, assertion.target);
        const property =
          assertion.type === "image-src-equals" ? "src" : "alt";
        const actual = state[property];
        const expected = normalizedText(assertion.expected);
        return normalizedText(actual) === expected
          ? passedResult(assertion, actual, expected)
          : failedResult(
              assertion,
              actual,
              expected,
              `Expected image ${assertion.slide}.${assertion.target} ${property} to equal "${expected}".`
            );
      }
      case "image-layout-equals":
      case "image-fit-equals": {
        const state = readImageState(html, assertion.slide, assertion.target);
        const property =
          assertion.type === "image-layout-equals" ? "layout" : "fit";
        const actual = state[property];
        const passed =
          normalizedText(actual) === normalizedText(assertion.expected) &&
          (property !== "layout" || state.slideLayout === actual);
        return passed
          ? passedResult(assertion, actual, assertion.expected)
          : failedResult(
              assertion,
              actual,
              assertion.expected,
              `Expected adaptive image ${property} to equal "${assertion.expected}".`
            );
      }
      case "image-dimensions-equal": {
        const state = readImageState(html, assertion.slide, assertion.target);
        const actual = { width: state.width, height: state.height };
        const expected = assertion.expected;
        const passed =
          actual.width === expected?.width && actual.height === expected?.height;
        return passed
          ? passedResult(assertion, actual, expected)
          : failedResult(
              assertion,
              actual,
              expected,
              `Expected adaptive image dimensions ${expected?.width}x${expected?.height}.`
            );
      }
      case "slide-exists":
      case "slide-absent": {
        const exists = slideOrder.includes(assertion.slide);
        const expected = assertion.type === "slide-exists";
        return exists === expected
          ? passedResult(assertion, exists, expected)
          : failedResult(
              assertion,
              exists,
              expected,
              `Expected slide "${assertion.slide}" to be ${expected ? "present" : "absent"}.`
            );
      }
      case "slide-after": {
        const index = slideOrder.indexOf(assertion.slide);
        const actual = index > 0 ? slideOrder[index - 1] : null;
        return actual === assertion.expected
          ? passedResult(assertion, actual)
          : failedResult(
              assertion,
              actual,
              assertion.expected,
              `Expected slide "${assertion.slide}" after "${assertion.expected}".`
            );
      }
      case "slide-layout-equals": {
        const actual = readSlideState(html, assertion.slide).layout;
        return actual === assertion.expected
          ? passedResult(assertion, actual)
          : failedResult(
              assertion,
              actual,
              assertion.expected,
              `Expected slide "${assertion.slide}" layout "${assertion.expected}".`
            );
      }
      case "slide-attribute-equals": {
        const actual =
          readSlideState(html, assertion.slide).attributes[assertion.target] ??
          "";
        return actual === assertion.expected
          ? passedResult(assertion, actual)
          : failedResult(
              assertion,
              actual,
              assertion.expected,
              `Expected slide "${assertion.slide}" attribute "${assertion.target}" to equal "${assertion.expected}".`
            );
      }
      default:
        return failedResult(
          assertion,
          null,
          assertion.expected ?? null,
          `Unsupported assertion type "${assertion.type}".`
        );
    }
  } catch (error) {
    return failedResult(
      assertion,
      null,
      assertion.expected ?? null,
      error.message
    );
  }
}

export function verifyChanges(html, plan) {
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    throw new Error("Change plan must contain a non-empty changes array.");
  }

  const verifiedAt = new Date().toISOString();
  const changes = plan.changes.map((change) => {
    const assertions = [
      ...automaticAssertions(change),
      ...(Array.isArray(change.assertions) ? change.assertions : [])
    ].map((assertion) => evaluateAssertion(html, assertion));
    const passed = assertions.length > 0 && assertions.every((assertion) => assertion.passed);
    return {
      ...change,
      status: passed ? "verified" : change.status === "blocked" ? "blocked" : "applied",
      verification: {
        passed,
        verifiedAt,
        assertions
      }
    };
  });
  const passed = changes.every((change) => change.verification.passed);

  return {
    plan: {
      ...plan,
      verifiedAt,
      changes
    },
    report: {
      schemaVersion: 1,
      verifiedAt,
      passed,
      totalChanges: changes.length,
      verifiedChanges: changes.filter((change) => change.status === "verified").length,
      failedChanges: changes
        .filter((change) => !change.verification.passed)
        .map((change) => change.id),
      changes: changes.map((change) => ({
        id: change.id,
        status: change.status,
        verification: change.verification
      }))
    }
  };
}
