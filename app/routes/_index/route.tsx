// Public landing page. Merchants normally reach the app from the Shopify
// admin (the `shop` query param triggers the redirect below); the form is the
// manual entry point for anyone landing here directly.

import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import stylesUrl from "./styles.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesUrl },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

const FEATURES = [
  {
    title: "Automated audits",
    body: "Monthly scheduled runs plus an automatic audit every time a theme is published, so every report is tied to a theme version.",
  },
  {
    title: "Lab and field data",
    body: "Lighthouse scores and Core Web Vitals from real users (CrUX), tracked over time per market, page type and device.",
  },
  {
    title: "Reports and alerts",
    body: "Plain-language summaries, before/after comparisons, PDF/CSV/JSON export, shareable links and threshold alerts.",
  },
];

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopError = actionData?.errors?.shop;

  return (
    <div className="pf-page">
      <header className="pf-header">
        <span className="pf-logo" aria-hidden="true">
          P
        </span>
        <span className="pf-brand">Performify</span>
      </header>

      <main className="pf-main">
        <section className="pf-hero">
          <div>
            <span className="pf-eyebrow">Storefront performance monitoring</span>
            <h1 className="pf-title">
              Know how fast your Shopify storefront really is
            </h1>
            <p className="pf-lead">
              Performify runs Lighthouse audits through the PageSpeed Insights
              API across your markets and page types, keeps every run as a
              comparable snapshot, and tells you what changed and why.
            </p>
          </div>

          {showForm && (
            <div className="pf-card">
              <h2>Open the app</h2>
              <p>Enter your store domain to continue to the Shopify admin.</p>
              <Form className="pf-form" method="post">
                <label className="pf-field" htmlFor="shop">
                  Shop domain
                  <input
                    id="shop"
                    className="pf-input"
                    type="text"
                    name="shop"
                    placeholder="my-store.myshopify.com"
                    autoComplete="on"
                    aria-invalid={shopError ? "true" : undefined}
                    aria-describedby={shopError ? "shop-error" : "shop-hint"}
                  />
                  {shopError ? (
                    <p id="shop-error" className="pf-error" role="alert">
                      {shopError}
                    </p>
                  ) : (
                    <span id="shop-hint" className="pf-hint">
                      e.g. my-store.myshopify.com
                    </span>
                  )}
                </label>
                <button className="pf-button" type="submit">
                  Log in
                </button>
              </Form>
            </div>
          )}
        </section>

        <ul className="pf-features">
          {FEATURES.map((feature) => (
            <li className="pf-feature" key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="pf-footer">
        Open source, developed by{" "}
        <a href="https://aargonlab.com" target="_blank" rel="noreferrer">
          aargonlab
        </a>
        .
      </footer>
    </div>
  );
}
