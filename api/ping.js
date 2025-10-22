import { json } from "./_helpers.js";

export default function handler(req, res) {
  return json(res, 200, {
    ok: true,
    service: "up",
    route: "/api/ping"
  });
}
