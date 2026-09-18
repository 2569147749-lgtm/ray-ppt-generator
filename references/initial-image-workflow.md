# Initial Deck Images

Use this workflow when the user's first request already includes local images.
Do not wait until a later revision to inspect or place them.

## 1. Prepare the image request

Create a JSON file with one entry per supplied image:

```json
{
  "images": [
    {
      "source": "/absolute/path/to/product.png",
      "assetName": "product.png",
      "alt": "产品工作台首页",
      "purpose": "展示产品的核心工作区",
      "fit": "contain"
    }
  ]
}
```

`source` and `alt` are required. `assetName`, `purpose`, and `fit` are optional.
The default fit is `contain`. Use `cover` only when intentional cropping is
acceptable.

## 2. Initialize the deck with images

```bash
node scripts/new-deck.mjs \
  --template yellow-editorial \
  --out /absolute/path/to/deck \
  --images /absolute/path/to/requested-images.json
```

The command validates every image before creating the output, copies the files
to `assets/`, and writes `image-manifest.json`. Each manifest entry records the
source dimensions, aspect ratio, selected layout variant, relative asset path,
fit, alt text, and intended purpose.

## 3. Design the first draft from the manifest

Use image purpose and ratio while planning the narrative. Do not finish the
content structure first and force all images into one fixed frame afterward.

For every placed image:

1. create a `media-layout` containing `media-copy` and `media-frame`
2. add a stable semantic role to the `<img>`
3. execute `replace-image` against the copied absolute asset path
4. let the command synchronize image metadata and the slide layout variant

Use one large inspectable image when it is evidence. Keep secondary images out
unless they add distinct information.

## 4. Verify the first draft

Run static validation and objective verification for the initial placement
plan. Then run the normal visual audit on every slide. Inspect image integrity,
crop, legibility, copy/media balance, and desktop framing before delivery.
