const PROCESS_WIDTH = 1744;
const PROCESS_GAP = 50;
const PROCESS_TRAILING_INSET = 9.25;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
}

function plainText(value) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function readAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${escapeRegExp(name)}=["']([^"']*)["']`, "i"))?.[1];
}

function writeAttribute(tag, name, value) {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}=(["'])[^"']*\\1`, "i");
  const encoded = String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (pattern.test(tag)) return tag.replace(pattern, `${name}="${encoded}"`);
  return tag.replace(/\s*(\/?)>$/, ` ${name}="${encoded}"$1>`);
}

function writeStyleProperty(tag, property, value) {
  const current = readAttribute(tag, "style") ?? "";
  const declarations = current
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.startsWith(`${property}:`));
  declarations.push(`${property}:${value}`);
  return writeAttribute(tag, "style", declarations.join(";"));
}

function findOpeningByAttribute(html, name, value, start = 0, end = html.length) {
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\b${escapeRegExp(name)}=(["'])${escapeRegExp(value)}\\2[^>]*>`,
    "gi"
  );
  pattern.lastIndex = start;
  const match = pattern.exec(html);
  if (!match || match.index >= end) return null;
  return {
    tagName: match[1].toLowerCase(),
    start: match.index,
    openEnd: pattern.lastIndex,
    openingTag: match[0]
  };
}

function findElementRangeFromOpening(html, opening) {
  if (/\/>$/.test(opening.openingTag) || VOID_ELEMENTS.has(opening.tagName)) {
    return { ...opening, closeStart: opening.openEnd, end: opening.openEnd };
  }

  const pattern = new RegExp(`</?${escapeRegExp(opening.tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = opening.openEnd;
  let depth = 1;
  let match;
  while ((match = pattern.exec(html))) {
    const start = match.index;
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) {
      return {
        ...opening,
        closeStart: start,
        end: start + match[0].length
      };
    }
  }
  throw new Error(`Unclosed <${opening.tagName}> element.`);
}

function findElementByAttribute(html, name, value, start = 0, end = html.length) {
  const opening = findOpeningByAttribute(html, name, value, start, end);
  return opening ? findElementRangeFromOpening(html, opening) : null;
}

function replaceRange(html, range, replacement) {
  return html.slice(0, range.start) + replacement + html.slice(range.end);
}

function replaceInner(html, range, replacement) {
  return html.slice(0, range.openEnd) + replacement + html.slice(range.closeStart);
}

function replaceOpeningTag(html, range, openingTag) {
  return html.slice(0, range.start) + openingTag + html.slice(range.openEnd);
}

function findSlide(html, slideId) {
  const slide = findElementByAttribute(html, "data-slide-id", slideId);
  if (!slide || slide.tagName !== "section") {
    throw new Error(`Unknown slide "${slideId}".`);
  }
  return slide;
}

function findRole(html, slideId, role) {
  const slide = findSlide(html, slideId);
  const target = findElementByAttribute(
    html,
    "data-role",
    role,
    slide.openEnd,
    slide.closeStart
  );
  if (!target || target.start >= slide.closeStart) {
    throw new Error(`Slide "${slideId}" has no semantic target "${role}".`);
  }
  return target;
}

function listElementsByAttribute(html, name, value, start, end) {
  const elements = [];
  let cursor = start;
  while (cursor < end) {
    const opening = findOpeningByAttribute(html, name, value, cursor, end);
    if (!opening) break;
    const element = findElementRangeFromOpening(html, opening);
    if (element.end <= end) elements.push(element);
    cursor = opening.openEnd;
  }
  return elements;
}

function findUniqueCommandTarget(html, command) {
  const slide = findSlide(html, command.slide);
  let scope = slide;
  if (command.itemId) {
    const items = listElementsByAttribute(
      html,
      "data-item-id",
      command.itemId,
      slide.openEnd,
      slide.closeStart
    );
    if (items.length !== 1) {
      throw new Error(
        `Item locator "${command.itemId}" on "${command.slide}" must resolve to exactly one element.`
      );
    }
    scope = items[0];
  }
  const targets = listElementsByAttribute(
    html,
    "data-role",
    command.target,
    scope.openEnd,
    scope.closeStart
  );
  if (targets.length !== 1) {
    throw new Error(
      `Semantic target "${command.target}" on "${command.slide}" must resolve to exactly one element.`
    );
  }
  return targets[0];
}

function listSlides(html) {
  const slides = [];
  const pattern = /<section\b[^>]*\bdata-slide-id=(["'])([^"']+)\1[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const opening = {
      tagName: "section",
      start: match.index,
      openEnd: match.index + match[0].length,
      openingTag: match[0]
    };
    const range = findElementRangeFromOpening(html, opening);
    slides.push({
      ...range,
      id: match[2],
      layout: readAttribute(match[0], "data-layout") ?? "unknown"
    });
  }
  return slides;
}

function listItems(html, slideId, targetRole) {
  const container = findRole(html, slideId, targetRole);
  const items = [];
  const pattern = /<([a-z][\w:-]*)\b[^>]*\bdata-item-id=(["'])([^"']+)\2[^>]*>/gi;
  pattern.lastIndex = container.openEnd;
  let match;
  while ((match = pattern.exec(html)) && match.index < container.closeStart) {
    const range = findElementRangeFromOpening(html, {
      tagName: match[1].toLowerCase(),
      start: match.index,
      openEnd: pattern.lastIndex,
      openingTag: match[0]
    });
    if (range.end <= container.closeStart) {
      items.push({ ...range, id: match[3] });
    }
  }
  return { container, items };
}

function renderProcessItem(item) {
  if (!item?.id || !item?.title || !item?.body) {
    throw new Error("Process items require id, title, and body.");
  }
  return `<div class="step" data-item-id="${escapeHtml(item.id)}"><div class="step-number" data-role="item-number">00</div><h3 data-role="item-title" data-visual-autofix="fit-text" data-visual-min-font-size="28" data-edit>${escapeHtml(item.title)}</h3><p data-role="item-body" data-visual-autofix="fit-text" data-visual-min-font-size="20" data-edit>${escapeHtml(item.body)}</p></div>`;
}

function renderAgendaItem(item) {
  if (!item?.id || !item?.title || !item?.body) {
    throw new Error("Agenda items require id, title, and body.");
  }
  return `<div class="agenda-row" data-item-id="${escapeHtml(item.id)}"><span class="number" data-role="item-number">00</span><div><h3 data-role="item-title" data-visual-autofix="fit-text" data-visual-min-font-size="30" data-edit>${escapeHtml(item.title)}</h3><p data-role="item-body" data-visual-autofix="fit-text" data-visual-min-font-size="20" data-edit>${escapeHtml(item.body)}</p></div><span class="arrow">↗</span></div>`;
}

function adaptItems(html, slideId, targetRole) {
  const slide = findSlide(html, slideId);
  const layout = readAttribute(slide.openingTag, "data-layout");
  let { container, items } = listItems(html, slideId, targetRole);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const number = findElementByAttribute(
      html,
      "data-role",
      "item-number",
      items[index].openEnd,
      items[index].closeStart
    );
    if (!number || number.start >= items[index].closeStart) {
      throw new Error(`Item "${items[index].id}" is missing item-number.`);
    }
    html = replaceInner(html, number, String(index + 1).padStart(2, "0"));
  }

  ({ container, items } = listItems(html, slideId, targetRole));
  let openingTag = writeAttribute(container.openingTag, "data-item-count", items.length);
  if (layout === "process") {
    const connectorRight =
      (PROCESS_WIDTH - (items.length - 1) * PROCESS_GAP) /
        items.length /
        2 -
      PROCESS_TRAILING_INSET;
    const rounded = Number(connectorRight.toFixed(2));
    openingTag = writeStyleProperty(openingTag, "--item-count", items.length);
    openingTag = writeStyleProperty(
      openingTag,
      "--connector-right",
      `${rounded}px`
    );
  }
  html = replaceOpeningTag(html, container, openingTag);
  if (layout === "agenda") {
    const count = findRole(html, slideId, "item-count");
    html = replaceInner(html, count, String(items.length).padStart(2, "0"));
  }
  return html;
}

function setText(html, command) {
  const target = findRole(html, command.slide, command.target);
  if (command.value === undefined) {
    throw new Error(`Change "${command.id}" is missing value.`);
  }
  return replaceInner(html, target, escapeHtml(command.value));
}

function fitText(html, command) {
  const fontSize = Number(command.fontSize);
  const minFontSize = Number(command.minFontSize);
  if (!Number.isFinite(fontSize) || fontSize < 8) {
    throw new Error(`Change "${command.id}" fontSize must be at least 8px.`);
  }
  if (
    !Number.isFinite(minFontSize) ||
    minFontSize < 8 ||
    fontSize < minFontSize
  ) {
    throw new Error(
      `Change "${command.id}" fontSize must respect a minimum of at least 8px.`
    );
  }
  const target = findUniqueCommandTarget(html, command);
  const openingTag = writeStyleProperty(
    target.openingTag,
    "font-size",
    `${fontSize}px`
  );
  return replaceOpeningTag(html, target, openingTag);
}

function replaceImage(html, command) {
  const target = findRole(html, command.slide, command.target);
  if (target.tagName !== "img") {
    throw new Error(
      `Semantic target "${command.target}" on "${command.slide}" is not an image.`
    );
  }
  let mediaLayout;
  try {
    mediaLayout = findRole(html, command.slide, "media-layout");
  } catch {
    throw new Error(
      `Slide "${command.slide}" does not expose the adaptive media-layout contract.`
    );
  }
  if (target.start < mediaLayout.openEnd || target.end > mediaLayout.closeStart) {
    throw new Error(
      `Semantic image "${command.target}" is outside the adaptive media-layout contract.`
    );
  }
  if (!command.src || !command.alt) {
    throw new Error(`Change "${command.id}" requires src and alt.`);
  }
  if (
    !Number.isInteger(command.imageWidth) ||
    !Number.isInteger(command.imageHeight) ||
    !Number.isFinite(command.aspectRatio) ||
    !["portrait", "square", "landscape-standard", "landscape-wide"].includes(
      command.imageLayout
    ) ||
    !["contain", "cover"].includes(command.fit)
  ) {
    throw new Error(`Change "${command.id}" requires valid adaptive image metadata.`);
  }
  let openingTag = writeAttribute(target.openingTag, "src", command.src);
  openingTag = writeAttribute(openingTag, "alt", command.alt);
  openingTag = writeAttribute(openingTag, "data-image-layout", command.imageLayout);
  openingTag = writeAttribute(openingTag, "data-image-fit", command.fit);
  openingTag = writeAttribute(openingTag, "data-image-width", command.imageWidth);
  openingTag = writeAttribute(openingTag, "data-image-height", command.imageHeight);
  openingTag = writeAttribute(openingTag, "data-image-aspect", command.aspectRatio);
  html = replaceOpeningTag(html, target, openingTag);

  const slide = findSlide(html, command.slide);
  let slideTag = writeAttribute(
    slide.openingTag,
    "data-image-layout",
    command.imageLayout
  );
  slideTag = writeStyleProperty(slideTag, "--image-aspect", command.aspectRatio);
  slideTag = writeStyleProperty(slideTag, "--image-fit", command.fit);
  return replaceOpeningTag(html, slide, slideTag);
}

function addItem(html, command) {
  const slide = findSlide(html, command.slide);
  const layout = readAttribute(slide.openingTag, "data-layout");
  if (!["process", "agenda"].includes(layout)) {
    throw new Error(`add-item is not implemented for layout "${layout}".`);
  }
  const { container, items } = listItems(html, command.slide, command.target);
  if (items.some((item) => item.id === command.item?.id)) {
    throw new Error(`Duplicate item id "${command.item.id}".`);
  }

  const markup =
    layout === "process"
      ? renderProcessItem(command.item)
      : renderAgendaItem(command.item);
  let insertion = container.closeStart;
  if (command.after) {
    const anchor = items.find((item) => item.id === command.after);
    if (!anchor) throw new Error(`Unknown item "${command.after}".`);
    insertion = anchor.end;
  }
  html = html.slice(0, insertion) + `\n    ${markup}` + html.slice(insertion);
  return adaptItems(html, command.slide, command.target);
}

function removeItem(html, command) {
  const { items } = listItems(html, command.slide, command.target);
  const item = items.find((entry) => entry.id === command.itemId);
  if (!item) throw new Error(`Unknown item "${command.itemId}".`);
  html = replaceRange(html, item, "");
  return adaptItems(html, command.slide, command.target);
}

function removeActiveClass(openingTag) {
  const classes = (readAttribute(openingTag, "class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => name !== "active");
  return writeAttribute(openingTag, "class", classes.join(" "));
}

function setActiveSlide(html) {
  const slides = listSlides(html);
  if (slides.length === 0) throw new Error("Deck has no slides.");
  const active =
    slides.find((slide) =>
      (readAttribute(slide.openingTag, "class") ?? "").split(/\s+/).includes("active")
    ) ?? slides[0];

  for (let index = slides.length - 1; index >= 0; index -= 1) {
    const slide = slides[index];
    let classes = (readAttribute(slide.openingTag, "class") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((name) => name !== "active");
    if (slide.id === active.id) classes.push("active");
    html = replaceOpeningTag(
      html,
      slide,
      writeAttribute(slide.openingTag, "class", classes.join(" "))
    );
  }
  return html;
}

function addSlide(html, command) {
  const candidateSlides = listSlides(command.html ?? "");
  if (candidateSlides.length !== 1) {
    throw new Error(`Change "${command.id}" must provide exactly one slide.`);
  }
  const candidate = candidateSlides[0];
  if (listSlides(html).some((slide) => slide.id === candidate.id)) {
    throw new Error(`Duplicate slide id "${candidate.id}".`);
  }
  if (!findElementByAttribute(command.html, "data-role", "title")) {
    throw new Error(`New slide "${candidate.id}" is missing title role.`);
  }
  if (!findElementByAttribute(command.html, "data-role", "page-number")) {
    throw new Error(`New slide "${candidate.id}" is missing page-number role.`);
  }

  const cleanOpening = removeActiveClass(candidate.openingTag);
  const markup = replaceOpeningTag(command.html, candidate, cleanOpening).trim();
  const slides = listSlides(html);
  let insertion = slides.at(-1).end;
  if (command.after) {
    const anchor = slides.find((slide) => slide.id === command.after);
    if (!anchor) throw new Error(`Unknown slide "${command.after}".`);
    insertion = anchor.end;
  }
  return html.slice(0, insertion) + `\n${markup}` + html.slice(insertion);
}

function deleteSlide(html, command) {
  const slides = listSlides(html);
  if (slides.length <= 2) throw new Error("A deck must keep at least two slides.");
  return replaceRange(html, findSlide(html, command.slide), "");
}

function moveSlide(html, command) {
  if (!command.after) throw new Error(`Change "${command.id}" requires after.`);
  if (command.after === command.slide) {
    throw new Error("A slide cannot be moved after itself.");
  }
  const moving = findSlide(html, command.slide);
  const markup = html.slice(moving.start, moving.end);
  html = replaceRange(html, moving, "");
  const anchor = findSlide(html, command.after);
  return html.slice(0, anchor.end) + `\n${markup}` + html.slice(anchor.end);
}

function splitSlide(html, command) {
  if (!command.newSlide) {
    throw new Error(`Change "${command.id}" requires newSlide.`);
  }
  if (!command.target) {
    throw new Error(`Change "${command.id}" requires target.`);
  }
  if (!Array.isArray(command.moveItemIds) || command.moveItemIds.length === 0) {
    throw new Error(`Change "${command.id}" requires moveItemIds.`);
  }
  if (new Set(command.moveItemIds).size !== command.moveItemIds.length) {
    throw new Error(`Change "${command.id}" has duplicate moveItemIds.`);
  }

  const source = findSlide(html, command.slide);
  const sourceLayout = readAttribute(source.openingTag, "data-layout");
  if (!["agenda", "process"].includes(sourceLayout)) {
    throw new Error(`split-slide is not implemented for layout "${sourceLayout}".`);
  }
  const sourceItems = listItems(html, command.slide, command.target).items;
  const movedIds = sourceItems
    .filter((item) => command.moveItemIds.includes(item.id))
    .map((item) => item.id);
  if (movedIds.length !== command.moveItemIds.length) {
    const missing = command.moveItemIds.filter(
      (itemId) => !sourceItems.some((item) => item.id === itemId)
    );
    throw new Error(`Unknown item "${missing[0]}".`);
  }

  const candidateSlides = listSlides(command.html ?? "");
  if (candidateSlides.length !== 1) {
    throw new Error(`Change "${command.id}" must provide exactly one slide.`);
  }
  const candidate = candidateSlides[0];
  if (candidate.id !== command.newSlide) {
    throw new Error(
      `New slide id "${candidate.id}" does not match newSlide "${command.newSlide}".`
    );
  }
  if (candidate.layout !== sourceLayout) {
    throw new Error(
      `Split slide "${candidate.id}" must use source layout "${sourceLayout}".`
    );
  }
  const candidateItemIds = listItems(
    command.html,
    command.newSlide,
    command.target
  ).items.map((item) => item.id);
  if (
    candidateItemIds.length !== movedIds.length ||
    candidateItemIds.some((itemId, index) => itemId !== movedIds[index])
  ) {
    throw new Error(
      `Split slide "${candidate.id}" must contain exactly the moved items in source order.`
    );
  }

  for (const itemId of [...movedIds].reverse()) {
    html = removeItem(html, {
      ...command,
      slide: command.slide,
      itemId
    });
  }
  const candidateHtml = adaptItems(
    command.html,
    command.newSlide,
    command.target
  );
  return addSlide(html, {
    ...command,
    command: "add-slide",
    after: command.slide,
    html: candidateHtml
  });
}

function syncPageNumbers(html) {
  let slides = listSlides(html);
  const total = slides.length;
  for (let index = slides.length - 1; index >= 0; index -= 1) {
    const pageNumber = findElementByAttribute(
      html,
      "data-role",
      "page-number",
      slides[index].openEnd,
      slides[index].closeStart
    );
    if (!pageNumber || pageNumber.start >= slides[index].closeStart) {
      throw new Error(`Slide "${slides[index].id}" is missing page-number.`);
    }
    html = replaceInner(
      html,
      pageNumber,
      `${String(index + 1).padStart(2, "0")} — ${String(total).padStart(2, "0")}`
    );
  }

  const counter = findElementByAttribute(html, "id", "counter");
  if (counter) {
    html = replaceInner(html, counter, `01 / ${String(total).padStart(2, "0")}`);
  }
  return setActiveSlide(html);
}

export function applyCommands(html, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error("Command batch must contain at least one change.");
  }
  const ids = new Set();
  let working = html;
  const affected = new Set();

  for (const command of changes) {
    if (!command.id) throw new Error("Every command requires an id.");
    if (ids.has(command.id)) throw new Error(`Duplicate command id "${command.id}".`);
    ids.add(command.id);

    switch (command.command) {
      case "set-text":
        working = setText(working, command);
        affected.add(command.slide);
        break;
      case "fit-text":
        working = fitText(working, command);
        affected.add(command.slide);
        break;
      case "add-item":
        working = addItem(working, command);
        affected.add(command.slide);
        break;
      case "remove-item":
        working = removeItem(working, command);
        affected.add(command.slide);
        break;
      case "replace-image":
        working = replaceImage(working, command);
        affected.add(command.slide);
        break;
      case "add-slide": {
        working = addSlide(working, command);
        const newSlide = listSlides(command.html)[0];
        affected.add(newSlide.id);
        break;
      }
      case "delete-slide":
        working = deleteSlide(working, command);
        affected.add(command.slide);
        break;
      case "move-slide":
        working = moveSlide(working, command);
        affected.add(command.slide);
        break;
      case "split-slide":
        working = splitSlide(working, command);
        affected.add(command.slide);
        affected.add(command.newSlide);
        break;
      default:
        throw new Error(`Unsupported command "${command.command}".`);
    }
  }

  working = syncPageNumbers(working);
  return {
    html: working,
    results: changes.map((change) => ({ id: change.id, status: "applied" })),
    affectedSlides: [...affected].sort(),
    slideIds: listSlides(working).map((slide) => slide.id)
  };
}

export function readSlideOrder(html) {
  return listSlides(html).map((slide) => slide.id);
}

export function readSlideState(html, slideId) {
  const slide = findSlide(html, slideId);
  return {
    id: slide.id,
    layout: readAttribute(slide.openingTag, "data-layout") ?? "",
    attributes: Object.fromEntries(
      [...slide.openingTag.matchAll(/\b([\w:-]+)=(["'])(.*?)\2/g)].map(
        (match) => [match[1], match[3]]
      )
    )
  };
}

export function readSemanticText(html, slideId, role) {
  const target = findRole(html, slideId, role);
  return plainText(html.slice(target.openEnd, target.closeStart));
}

export function readItemState(html, slideId, targetRole = "items") {
  const { items } = listItems(html, slideId, targetRole);
  return {
    count: items.length,
    ids: items.map((item) => item.id),
    numbers: items.map((item) => {
      const number = findElementByAttribute(
        html,
        "data-role",
        "item-number",
        item.openEnd,
        item.closeStart
      );
      return number && number.start < item.closeStart
        ? plainText(html.slice(number.openEnd, number.closeStart))
        : null;
    })
  };
}

export function readItemText(html, slideId, targetRole, itemId, role) {
  const { items } = listItems(html, slideId, targetRole);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Unknown item "${itemId}".`);
  const target = findElementByAttribute(
    html,
    "data-role",
    role,
    item.openEnd,
    item.closeStart
  );
  if (!target || target.start >= item.closeStart) {
    throw new Error(`Item "${itemId}" has no semantic target "${role}".`);
  }
  return plainText(html.slice(target.openEnd, target.closeStart));
}

export function readImageState(html, slideId, role) {
  const target = findRole(html, slideId, role);
  if (target.tagName !== "img") {
    throw new Error(`Semantic target "${role}" on "${slideId}" is not an image.`);
  }
  const slide = findSlide(html, slideId);
  return {
    src: readAttribute(target.openingTag, "src") ?? "",
    alt: readAttribute(target.openingTag, "alt") ?? "",
    width: Number(readAttribute(target.openingTag, "data-image-width") ?? 0),
    height: Number(readAttribute(target.openingTag, "data-image-height") ?? 0),
    aspectRatio: Number(
      readAttribute(target.openingTag, "data-image-aspect") ?? 0
    ),
    layout: readAttribute(target.openingTag, "data-image-layout") ?? "",
    fit: readAttribute(target.openingTag, "data-image-fit") ?? "",
    slideLayout: readAttribute(slide.openingTag, "data-image-layout") ?? ""
  };
}
