export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Booking lookup is not configured." });
  }

  const bookingToken = String(req.query.bookingToken || "");
  const currency = String(req.query.currencyCode || "INR").toUpperCase();

  if (!bookingToken || bookingToken.length > 20000) {
    return res.status(400).json({ error: "A valid flight booking token is required." });
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: "Invalid currency code." });
  }

  try {
    const params = new URLSearchParams({
      engine: "google_flights",
      booking_token: bookingToken,
      currency,
      hl: "en",
      api_key: apiKey
    });

    const response = await fetch(
      "https://serpapi.com/search.json?" + params.toString(),
      { signal: AbortSignal.timeout(18000) }
    );

    const body = await response.json();

    if (!response.ok || body.error) {
      console.error("Booking lookup failed:", body.error || response.status);
      return res.status(502).json({
        error: "Could not retrieve booking providers for this flight."
      });
    }

    const raw = Array.isArray(body.booking_options)
      ? body.booking_options
      : Array.isArray(body.booking_options?.options)
        ? body.booking_options.options
        : [];

    const seen = new Set();

    const options = raw.map(item => {
      const candidates = [
        item.url,
        item.booking_url,
        item.link,
        item.redirect_link,
        item.booking_request?.url,
        item.booking_request?.link
      ];

      const url = candidates.find(value => {
        try {
          return typeof value === "string" &&
            new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      });

      if (!url || seen.has(url)) return null;
      seen.add(url);

      const rawPrice = item.price ?? item.price_value ?? item.total_price;
      const parsedPrice = Number(String(rawPrice ?? "").replace(/[^0-9.]/g, ""));

      return {
        name: String(
          item.book_with || item.provider || item.name || item.title || "Booking provider"
        ).slice(0, 120),
        url,
        price: Number.isFinite(parsedPrice) && parsedPrice > 0
          ? parsedPrice
          : null,
        currency: String(item.currency || currency).slice(0, 3)
      };
    }).filter(Boolean).sort(
      (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)
    );

    return res.status(200).json({
      count: options.length,
      options,
      message: options.length
        ? undefined
        : "No direct booking links were returned for this flight."
    });
  } catch (error) {
    console.error("Booking lookup error:", error.message);
    return res.status(502).json({
      error: "Booking lookup failed or timed out. Please try again."
    });
  }
}
