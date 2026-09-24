/**
 * Credits footer shown at the bottom of every embedded admin page.
 * Uses Polaris web components so it inherits the admin look & feel.
 */
export function Footer() {
  return (
    <s-box padding="base" paddingBlockStart="large">
      <s-stack direction="inline" justifyContent="center" gap="small-200">
        <s-text color="subdued">
          Performify is open source, developed by{" "}
          <s-link href="https://aargonlab.com" target="_blank">
            aargonlab
          </s-link>
          .
        </s-text>
      </s-stack>
    </s-box>
  );
}
