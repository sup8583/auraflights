
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

    const rawOptions = Array.isArray(body.booking_options)
      ? body.booking_options
      : Array.isArray(body.booking_options?.options)
        ? body.booking_options.options
        : [];

    const candidates = [];

    for (const item of rawOptions) {
      const together = item.together || {};
      const request = together.booking_request || item.booking_request || {};

      const urls = [
        item.url,
        item.booking_url,
        item.link,
        item.redirect_link,
        together.url,
        together.booking_url,
        together.link,
        request.url,
        request.link
      ];

      const url = urls.find(value => {
        try {
          const parsed = new URL(value);
          return typeof value === "string" && parsed.protocol === "https:";
        } catch {
          return false;
        }
      });

      if (!url) continue;

      const rawPrice =
        item.price ??
        item.price_value ??
        item.total_price ??
        together.price ??
        together.price_value;

      const parsedPrice = Number(
        String(rawPrice ?? "").replace(/[^0-9.]/g, "")
      );

      candidates.push({
        name: String(
          item.book_with ||
          item.provider ||
          item.name ||
          item.title ||
          together.book_with ||
          together.provider ||
          "Booking provider"
        ).slice(0, 120),
        url,
        price: Number.isFinite(parsedPrice) && parsedPrice > 0
          ? parsedPrice
          : null,
        currency: String(item.currency || currency).slice(0, 3)
      });
    }

    const seen = new Set();
    const options = candidates
      .filter(option => {
        if (seen.has(option.url)) return false;
        seen.add(option.url);
        return true;
      })
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    return res.status(200).json({
      count: options.length,
      options,
      message: options.length
        ? undefined
        : "The provider returned no direct booking links for this flight."
    });
  } catch (error) {
    console.error("Booking lookup error:", error.message);
    return res.status(502).json({
      error: "Booking lookup failed or timed out. Please try again."
    });
  }
}
