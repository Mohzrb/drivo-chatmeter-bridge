// api/print-env.js
export default async function handler(req, res) {
  const pick = (k) => (process.env[k] == null ? null : String(process.env[k]));
  const present = (k) => process.env[k] != null && process.env[k] !== "";

  const out = {
    ok: true,
    route: "/api/print-env",
    version: "print-env-2025-10-23",
    presence: {
      CHATMETER_V5_BASE: present("CHATMETER_V5_BASE"),
      CHATMETER_V5_TOKEN: present("CHATMETER_V5_TOKEN"),
      CHATMETER_AUTH_STYLE: pick("CHATMETER_AUTH_STYLE"),
      CHATMETER_REVIEWS_URL: present("CHATMETER_REVIEWS_URL"),
      ZENDESK_SUBDOMAIN: present("ZENDESK_SUBDOMAIN"),
      ZENDESK_EMAIL: present("ZENDESK_EMAIL"),
      ZENDESK_API_TOKEN: present("ZENDESK_API_TOKEN"),
    },
    values: {
      CHATMETER_REVIEWS_URL: pick("CHATMETER_REVIEWS_URL"),
    },
  };

  res.status(200).json(out);
}
