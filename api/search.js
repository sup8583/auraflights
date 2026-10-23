export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, AMADEUS_ENV = "test" } = process.env;
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    return res.status(503).json({
      error: "Live flight search is not configured yet.",
      code: "AMADEUS_NOT_CONFIGURED",
      message: "Add AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET in Vercel Environment Variables."
    });
  }

  const origin = String(req.query.origin || "").trim().toUpperCase();
  const destination = String(req.query.destination || "").trim().toUpperCase();
  const departureDate = String(req.query.departureDate || "").trim();
  const returnDate = String(req.query.returnDate || "").trim();
  const adults = Math.min(9, Math.max(1, Number.parseInt(req.query.adults || "1", 10) || 1));
  const maxPrice = Number.parseInt(req.query.maxPrice || "", 10);
  const currencyCode = String(req.query.currencyCode || "INR").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    return res.status(400).json({ error: "Enter valid three-letter airport/city codes, such as BLR and DXB." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate) || Number.isNaN(Date.parse(departureDate))) {
    return res.status(400).json({ error: "Choose a valid departure date (YYYY-MM-DD)." });
  }
  if (departureDate < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "Departure date must be today or later." });
  }
  if (returnDate && (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || Number.isNaN(Date.parse(returnDate)) || returnDate < departureDate)) {
    return res.status(400).json({ error: "Choose a valid return date on or after departure." });
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return res.status(400).json({ error: "Currency must be a three-letter code." });
  }

  const baseUrl = AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

  try {
    const tokenResponse = await fetch(baseUrl + "/v1/security/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: AMADEUS_CLIENT_ID,
        client_secret: AMADEUS_CLIENT_SECRET
      })
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) {
      console.error("Amadeus token request failed:", tokenResponse.status, tokenBody.error);
      return res.status(502).json({
        error: "Flight provider authentication failed. Check the Amadeus credentials and environment."
      });
    }

    const params = new URLSearchParams({
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate,
      adults: String(adults),
      currencyCode,
      max: "20"
    });
    if (returnDate) params.set("returnDate", returnDate);
    if (Number.isFinite(maxPrice) && maxPrice > 0) params.set("maxPrice", String(maxPrice));

    const offersResponse = await fetch(baseUrl + "/v2/shopping/flight-offers?" + params.toString(), {
      headers: { Authorization: "Bearer " + tokenBody.access_token }
    });
    const offersBody = await offersResponse.json();
    if (!offersResponse.ok) {
      const providerMessage = offersBody?.errors?.[0]?.detail || offersBody?.errors?.[0]?.title;
      console.error("Amadeus offers request failed:", offersResponse.status, providerMessage);
      return res.status(offersResponse.status === 429 ? 429 : 502).json({
        error: providerMessage || "The flight provider could not return offers for this search."
      });
    }

    const dictionaries = offersBody.dictionaries || {};
    const offers = (offersBody.data || []).map((offer) => {
      const itinerary = offer.itineraries?.[0];
      const segments = itinerary?.segments || [];
      const first = segments[0];
      const last = segments[segments.length - 1];
      const carrier = first?.carrierCode || "";
      return {
        id: offer.id,
        price: Number(offer.price?.grandTotal || offer.price?.total || 0),
        currency: offer.price?.currency || currencyCode,
        airlineCode: carrier,
        airline: dictionaries.carriers?.[carrier] || carrier || "Airline",
        origin: first?.departure?.iataCode || origin,
        destination: last?.arrival?.iataCode || destination,
        departureAt: first?.departure?.at || null,
        arrivalAt: last?.arrival?.at || null,
        stops: Math.max(0, segments.length - 1),
        duration: itinerary?.duration || null,
        seatsAvailable: offer.numberOfBookableSeats || null,
        segments: segments.map((segment) => ({
          from: segment.departure?.iataCode,
          to: segment.arrival?.iataCode,
          departureAt: segment.departure?.at,
          arrivalAt: segment.arrival?.at,
          airlineCode: segment.carrierCode,
          flightNumber: segment.number
        }))
      };
    }).sort((a, b) => a.price - b.price);

    return res.status(200).json({
      source: "amadeus",
      liveOffers: true,
      currency: currencyCode,
      count: offers.length,
      offers
    });
  } catch (error) {
    console.error("Flight search error:", error);
    return res.status(500).json({ error: "Unexpected error while searching flights. Please try again." });
  }
}
