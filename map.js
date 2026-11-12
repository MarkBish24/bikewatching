// Import Mapbox as an ESM module
import mapboxgl from "https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// Check that Mapbox GL JS is loaded
console.log("Mapbox GL JS Loaded:", mapboxgl);

// Set your Mapbox access token here
mapboxgl.accessToken =
  "pk.eyJ1IjoibWFya2Jpc2gyNC03NGMxIiwiYSI6ImNtd2R6aGFheDAxNWEzMW9tcDZuOGVvd24ifQ.hzrmFZrqnIEmCMbbBIrUvQ";

// Initialize the map
const map = new mapboxgl.Map({
  container: "map", // ID of the div where the map will render
  style: "mapbox://styles/mapbox/streets-v12", // Map style
  center: [-71.09415, 42.36027], // [longitude, latitude] — MIT / Cambridge
  zoom: 12, // Initial zoom level
  minZoom: 5, // Minimum allowed zoom
  maxZoom: 18, // Maximum allowed zoom
});

// Shared styling for all bike lane layers
const bikeLaneStyle = {
  "line-color": "#32D400", // Bright green
  "line-width": 3,
  "line-opacity": 0.5,
};

// SVG overlay that holds the station markers
const svg = d3.select("#map").select("svg");

// Convert a station's lon/lat into pixel coordinates on the current map view
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat); // Convert lon/lat to Mapbox LngLat
  const { x, y } = map.project(point); // Project to pixel coordinates
  return { cx: x, cy: y }; // Return as object for use in SVG attributes
}

// Wait for the map to load before adding data
map.on("load", async () => {
  // Boston bike lanes
  map.addSource("boston_route", {
    type: "geojson",
    data: "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson",
  });

  map.addLayer({
    id: "bike-lanes-boston",
    type: "line",
    source: "boston_route",
    paint: bikeLaneStyle,
  });

  // Cambridge bike lanes
  map.addSource("cambridge_route", {
    type: "geojson",
    data: "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson",
  });

  map.addLayer({
    id: "bike-lanes-cambridge",
    type: "line",
    source: "cambridge_route",
    paint: bikeLaneStyle,
  });

  // Bluebikes stations
  let jsonData;
  try {
    const jsonurl = "https://dsc106.com/labs/lab07/data/bluebikes-stations.json";

    // Await JSON fetch
    jsonData = await d3.json(jsonurl);

    console.log("Loaded JSON Data:", jsonData); // Log to verify structure
  } catch (error) {
    console.error("Error loading JSON:", error); // Handle errors
    return;
  }

  let stations = jsonData.data.stations;
  console.log("Stations Array:", stations);

  // Bluebikes traffic for March 2024
  const parseTime = d3.timeParse("%Y-%m-%d %H:%M:%S");
  const trips = await d3.csv(
    "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv",
    (trip) => {
      trip.started_at = parseTime(trip.started_at);
      trip.ended_at = parseTime(trip.ended_at);
      trip.is_member = +trip.is_member;
      return trip;
    },
  );
  console.log("Loaded trips:", trips.length);

  // Trip counts per station
  const departures = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.end_station_id,
  );

  // Extra per-station details for the tooltip, based on trips that start there
  const departureDetails = d3.rollup(
    trips,
    (v) => ({
      memberShare: d3.mean(v, (d) => d.is_member),
      electricShare: d3.mean(v, (d) => (d.bike_type === "electric" ? 1 : 0)),
      medianMinutes: d3.median(v, (d) => (d.ended_at - d.started_at) / 60000),
      peakHour: d3.greatest(
        d3.rollups(
          v,
          (g) => g.length,
          (d) => d.started_at.getHours(),
        ),
        ([, count]) => count,
      )?.[0],
      topDestination: d3.greatest(
        d3.rollups(
          v.filter((d) => d.end_station_id !== d.start_station_id),
          (g) => g.length,
          (d) => d.end_station_id,
        ),
        ([, count]) => count,
      ),
    }),
    (d) => d.start_station_id,
  );

  // Look up station names by ID (used for "top destination")
  const stationNames = new Map(stations.map((s) => [s.short_name, s.name]));

  stations = stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    station.details = departureDetails.get(id) ?? null;
    return station;
  });
  console.log("Stations with traffic:", stations);

  // Size circles by area (not radius) so they represent traffic honestly
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // Custom tooltip element
  const tooltip = d3.select("#tooltip");

  // Append circles to the SVG for each station
  const circles = svg
    .selectAll("circle")
    .data(stations)
    .enter()
    .append("circle")
    .attr("r", (d) => radiusScale(d.totalTraffic)) // Radius sized by traffic
    .each(function (d) {
      // Add <title> for browser tooltips
      d3.select(this)
        .append("title")
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    })
    .on("mouseenter", function (event, d) {
      // Hide the native <title> tooltip while the custom one is showing
      d3.select(this).select("title").text("");
      tooltip.html(tooltipHTML(d)).attr("hidden", null);
      moveTooltip(event);
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", function (event, d) {
      d3.select(this)
        .select("title")
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
      tooltip.attr("hidden", true);
    });

  // Keep the tooltip next to the cursor, flipping it if it would leave the screen
  function moveTooltip(event) {
    const node = tooltip.node();
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + node.offsetWidth > window.innerWidth) {
      x = event.clientX - node.offsetWidth - pad;
    }
    if (y + node.offsetHeight > window.innerHeight) {
      y = event.clientY - node.offsetHeight - pad;
    }
    tooltip.style("left", `${x}px`).style("top", `${y}px`);
  }

  // Build the tooltip contents for one station
  function tooltipHTML(d) {
    const fmt = d3.format(",");
    const pct = d3.format(".0%");
    const net = d.departures - d.arrivals;
    const netText =
      net === 0
        ? "Balanced"
        : net > 0
          ? `${fmt(net)} more bikes leave than arrive`
          : `${fmt(-net)} more bikes arrive than leave`;
    const hourLabel = (h) => {
      const t = new Date(2024, 0, 1, h);
      return `${d3.timeFormat("%-I %p")(t)}–${d3.timeFormat("%-I %p")(new Date(2024, 0, 1, h + 1))}`;
    };
    const share = d.totalTraffic ? d.departures / d.totalTraffic : 0.5;

    let html = `
      <h2>${d.name}</h2>
      <p class="muted">${d.short_name} · ${d.capacity} docks</p>
      <p class="total"><strong>${fmt(d.totalTraffic)}</strong> trips in March 2024</p>
      <div class="flow-bar" aria-hidden="true">
        <span class="dep" style="width:${share * 100}%"></span>
      </div>
      <dl>
        <dt><i class="swatch dep"></i>Departures</dt><dd>${fmt(d.departures)}</dd>
        <dt><i class="swatch arr"></i>Arrivals</dt><dd>${fmt(d.arrivals)}</dd>
        <dt>Net flow</dt><dd>${netText}</dd>`;

    if (d.details) {
      const { memberShare, electricShare, medianMinutes, peakHour, topDestination } =
        d.details;
      html += `
        <dt>Members</dt><dd>${pct(memberShare)} of departures</dd>
        <dt>E-bikes</dt><dd>${pct(electricShare)} of departures</dd>
        <dt>Typical ride</dt><dd>${Math.round(medianMinutes)} min (median)</dd>
        <dt>Busiest hour</dt><dd>${hourLabel(peakHour)}</dd>`;
      if (topDestination) {
        const [destId, destCount] = topDestination;
        html += `<dt>Top destination</dt><dd>${stationNames.get(destId) ?? destId} (${fmt(destCount)} trips)</dd>`;
      }
    }

    return html + "</dl>";
  }

  // Function to update circle positions when the map moves/zooms
  function updatePositions() {
    circles
      .attr("cx", (d) => getCoords(d).cx) // Set the x-position using projected coordinates
      .attr("cy", (d) => getCoords(d).cy); // Set the y-position using projected coordinates
  }

  // Initial position update when map loads
  updatePositions();

  // Reposition markers on map interactions
  map.on("move", updatePositions); // Update during map movement
  map.on("zoom", updatePositions); // Update during zooming
  map.on("resize", updatePositions); // Update on window resize
  map.on("moveend", updatePositions); // Final adjustment after movement ends
});
