export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "Flight search is not configured.",
      code: "SERPAPI_NOT_CONFIGURED"
    });
  }

  const origin = String(req.query.origin || "").trim().toUpperCase();
  const destination = String(req.query.destination || "").trim().toUpperCase();
  const departureDate = String(req.query.departureDate || "").trim();
  const returnDate = String(req.query.returnDate || "").trim();
  const adults = Math.min(9, Math.max(1, parseInt(req.query.adults || "1", 10) || 1));
  const currencyCode = String(req.query.currencyCode || "INR").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(origin) ||
      !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    return res.status(400).json({ error: "Enter valid airport codes, such as BLR and DXB." });
  }

  const validDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };

  const today = new Date().toISOString().slice(0, 10);

  if (!validDate(departureDate) || departureDate < today) {
    return res.status(400).json({ error: "Choose a valid departure date today or later." });
  }

  if (returnDate && (!validDate(returnDate) || returnDate < departureDate)) {
    return res.status(400).json({ error: "Choose a valid return date on or after departure." });
  }

  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return res.status(400).json({ error: "Currency must be a three-letter code." });
  }

  try {
    const params = new URLSearchParams({
      engine: "google_flights",
      deep_search: "true",
      type: returnDate ? "1" : "2",
      departure_id: origin,
      arrival_id: destination,
      outbound_date: departureDate,
      adults: String(adults),
      currency: currencyCode,
      hl: "en",
      api_key: apiKey
    });

    if (returnDate) {
      params.set("return_date", returnDate);
    }

    const departureToken = String(req.query.departureToken || "").trim();
    if (departureToken) {
      if (departureToken.length > 20000) {
        return res.status(400).json({ error: "Invalid outbound flight selection." });
      }
      params.set("departure_token", departureToken);
    }

    const response = await fetch("https://serpapi.com/search.json?" + params.toString());
    const body = await response.json();

    if (!response.ok || body.error) {
      console.error("SerpApi flight search failed:", response.status, body.error || "Unknown error");
      return res.status(response.status === 429 ? 429 : 502).json({
        error: body.error || "The flight provider could not complete this search."
      });
    }

    const rawOffers = [
      ...(body.best_flights || []),
      ...(body.other_flights || [])
    ];

    console.log("SERPAPI OFFER FIELD NAMES:", JSON.stringify({
      topLevelKeys: Object.keys(body || {}),
      firstOfferKeys: Object.keys(rawOffers[0] || {}),
      firstFlightKeys: Object.keys(rawOffers[0]?.flights?.[0] || {}),
      hasDepartureToken: Boolean(rawOffers[0]?.departure_token),
      hasBookingToken: Boolean(rawOffers[0]?.booking_token)
    }));

    const offers = rawOffers.map((offer, index) => {
      const flights = offer.flights || [];
      const first = flights[0];
      const last = flights[flights.length - 1];

      if (!first || !last || !Number.isFinite(Number(offer.price))) return null;

      return {
        id: String(index + 1),
        price: Number(offer.price),
        currency: currencyCode,
        airline: [...new Set(flights.map(f => f.airline).filter(Boolean))].join(" / ") || "Airline",
        airlineCode: first.airline || "",
        origin: first.departure_airport?.id || origin,
        destination: last.arrival_airport?.id || destination,
        departureAt: first.departure_airport?.time || null,
        arrivalAt: last.arrival_airport?.time || null,
        stops: Math.max(0, flights.length - 1),
        duration: Number.isFinite(offer.total_duration)
          ? `${Math.floor(offer.total_duration / 60)}h ${offer.total_duration % 60}m`
          : null,
        segments: flights.map(f => ({
          from: f.departure_airport?.id || "",
          to: f.arrival_airport?.id || "",
          departureAt: f.departure_airport?.time || null,
          arrivalAt: f.arrival_airport?.time || null,
          airlineCode: f.airline || "",
          flightNumber: f.flight_number || ""
        })),
        bookingToken: offer.booking_token || null,
        departureToken: offer.departure_token || null
      };
    }).filter(Boolean).sort((a, b) => a.price - b.price);

    return res.status(200).json({
      source: "serpapi_google_flights",
      liveOffers: true,
      currency: currencyCode,
      count: offers.length,
      offers,
      searchInformation: body.search_metadata?.status || "completed"
    });
  } catch (error) {
    console.error("SerpApi request failed:", error.message);
    return res.status(502).json({ error: "Flight search failed. Please try again." });
  }
}
