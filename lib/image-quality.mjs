function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sourceKey(value) {
  return String(value ?? "").split(/[?#]/)[0];
}

function imageFinding(profile, image, code, severity, property, expected, actual, message) {
  return {
    code,
    severity,
    slide: profile.slide,
    layout: profile.layout,
    selectors: [image.selector],
    role: image.role ?? null,
    source: image.src,
    property,
    expected,
    actual,
    message
  };
}

export function analyzeImageQuality({ profiles = [], contract = null }) {
  const rules = contract?.imageQuality ?? {};
  const findings = [];
  const occurrences = new Map();

  for (const profile of profiles) {
    for (const image of profile.images ?? []) {
      const naturalWidth = numeric(image.naturalWidth);
      const naturalHeight = numeric(image.naturalHeight);
      const drawnWidth = numeric(image.drawnWidth);
      const drawnHeight = numeric(image.drawnHeight);
      const upscale =
        naturalWidth && naturalHeight && drawnWidth && drawnHeight
          ? Math.max(drawnWidth / naturalWidth, drawnHeight / naturalHeight)
          : null;

      if (
        upscale !== null &&
        rules.maxUpscaleBlocker !== undefined &&
        upscale > Number(rules.maxUpscaleBlocker)
      ) {
        findings.push(
          imageFinding(
            profile,
            image,
            "image-upscale",
            "blocker",
            "upscale",
            { max: Number(rules.maxUpscaleBlocker) },
            upscale,
            `${image.selector} is enlarged beyond the declared resolution limit.`
          )
        );
      } else if (
        upscale !== null &&
        rules.maxUpscaleWarning !== undefined &&
        upscale > Number(rules.maxUpscaleWarning)
      ) {
        findings.push(
          imageFinding(
            profile,
            image,
            "image-upscale",
            "warning",
            "upscale",
            { max: Number(rules.maxUpscaleWarning) },
            upscale,
            `${image.selector} is rendered above its natural pixel size.`
          )
        );
      }

      const sourceAspect = numeric(image.sourceAspect);
      const renderedAspect = numeric(image.renderedAspect);
      const aspectDistortion =
        sourceAspect && renderedAspect
          ? Math.abs(renderedAspect / sourceAspect - 1)
          : null;
      if (
        image.objectFit === "fill" &&
        aspectDistortion !== null &&
        rules.maxAspectDistortion !== undefined &&
        aspectDistortion > Number(rules.maxAspectDistortion)
      ) {
        findings.push(
          imageFinding(
            profile,
            image,
            "image-aspect-distortion",
            "blocker",
            "aspectDistortion",
            { max: Number(rules.maxAspectDistortion) },
            aspectDistortion,
            `${image.selector} stretches the source aspect ratio.`
          )
        );
      }

      const visibleFraction = numeric(image.visibleFraction);
      if (
        image.objectFit === "cover" &&
        !image.allowCrop &&
        visibleFraction !== null &&
        rules.minCoverVisibleFraction !== undefined &&
        visibleFraction < Number(rules.minCoverVisibleFraction)
      ) {
        findings.push(
          imageFinding(
            profile,
            image,
            "image-severe-crop",
            "warning",
            "visibleFraction",
            { min: Number(rules.minCoverVisibleFraction) },
            visibleFraction,
            `${image.selector} crops a large fraction of the source image.`
          )
        );
      }

      const key = sourceKey(image.src);
      if (key && !image.allowRepeat) {
        const entries = occurrences.get(key) ?? [];
        entries.push({ profile, image });
        occurrences.set(key, entries);
      }
    }
  }

  for (const [source, entries] of occurrences) {
    if (new Set(entries.map(({ profile }) => profile.slide)).size < 2) continue;
    for (const { profile, image } of entries) {
      findings.push(
        imageFinding(
          profile,
          image,
          "image-reused",
          "warning",
          "src",
          "unique across slides or explicitly allowed",
          source,
          `${image.selector} reuses the same image on multiple slides.`
        )
      );
    }
  }

  return {
    passed: !findings.some((finding) => finding.severity === "blocker"),
    checkedSlides: profiles.map((profile) => profile.slide),
    findings
  };
}
