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

// ---------- Time filtering helpers ----------

// Trips grouped by the minute of the day they started / ended (0–1439)
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// The currently selected time (-1 = any time)
let currentTimeFilter = -1;

// Format minutes since midnight as "h:mm AM/PM"
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes); // Set hours & minutes
  return date.toLocaleString("en-US", { timeStyle: "short" }); // Format as HH:MM AM/PM
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Get every trip within 60 minutes before or after `minute` from a set of buckets
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute + 1);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute + 1).flat();
  }
}

// Count arrivals, departures, and total traffic for each station
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter), // Efficient retrieval
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter), // Efficient retrieval
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// Extra tooltip details for one station, from its departures in the current time window.
// Computed on hover so it always matches the slider.
function computeStationDetails(stationId, timeFilter) {
  const v = filterByMinute(departuresByMinute, timeFilter).filter(
    (d) => d.start_station_id === stationId,
  );
  if (v.length === 0) return null;

  const busiest = (rows, key) =>
    d3.greatest(
      d3.rollups(rows, (g) => g.length, key),
      ([, count]) => count,
    );

  return {
    memberShare: d3.mean(v, (d) => d.is_member),
    electricShare: d3.mean(v, (d) => (d.bike_type === "electric" ? 1 : 0)),
    medianMinutes: d3.median(v, (d) => (d.ended_at - d.started_at) / 60000),
    peakHour: busiest(v, (d) => d.started_at.getHours())?.[0],
    topDestination: busiest(
      v.filter((d) => d.end_station_id !== d.start_station_id),
      (d) => d.end_station_id,
    ),
  };
}

// Map departure share (0–1) to three flow categories: more arrivals / balanced / more departures
let stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// Departure ratio for coloring; stations with no trips count as balanced
function departureRatio(d) {
  return stationFlow(d.totalTraffic ? d.departures / d.totalTraffic : 0.5);
}

function titleText(d) {
  return `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;
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

  // Bluebikes traffic for March 2024, sorted into minute-of-day buckets as it loads
  const parseTime = d3.timeParse("%Y-%m-%d %H:%M:%S");
  let trips = await d3.csv(
    "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv",
    (trip) => {
      trip.started_at = parseTime(trip.started_at);
      trip.ended_at = parseTime(trip.ended_at);
      trip.is_member = +trip.is_member;

      let startedMinutes = minutesSinceMidnight(trip.started_at);
      departuresByMinute[startedMinutes].push(trip);

      let endedMinutes = minutesSinceMidnight(trip.ended_at);
      arrivalsByMinute[endedMinutes].push(trip);

      return trip;
    },
  );
  console.log("Loaded trips:", trips.length);

  const stations = computeStationTraffic(jsonData.data.stations);
  console.log("Stations with traffic:", stations);

  // Look up station names by ID (used for "top destination")
  const stationNames = new Map(stations.map((s) => [s.short_name, s.name]));

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
    .data(stations, (d) => d.short_name) // Use station short_name as the key
    .enter()
    .append("circle")
    .attr("r", (d) => radiusScale(d.totalTraffic)) // Radius sized by traffic
    .style("--departure-ratio", departureRatio) // Color by traffic flow
    .each(function (d) {
      // Add <title> for browser tooltips
      d3.select(this).append("title").text(titleText(d));
    })
    .on("mouseenter", function (event, d) {
      // Hide the native <title> tooltip while the custom one is showing
      d3.select(this).select("title").text("");
      tooltip.html(tooltipHTML(d)).attr("hidden", null);
      moveTooltip(event);
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", function (event, d) {
      d3.select(this).select("title").text(titleText(d));
      tooltip.attr("hidden", true);
    });

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

  // ---------- Time slider ----------
  const timeSlider = document.getElementById("time-slider");
  const selectedTime = document.getElementById("selected-time");
  const anyTimeLabel = document.getElementById("any-time");

  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value); // Get slider value

    if (timeFilter === -1) {
      selectedTime.textContent = ""; // Clear time display
      anyTimeLabel.style.display = "block"; // Show "(any time)"
    } else {
      selectedTime.textContent = formatTime(timeFilter); // Display formatted time
      anyTimeLabel.style.display = "none"; // Hide "(any time)"
    }

    // Call updateScatterPlot to reflect the changes on the map
    updateScatterPlot(timeFilter);
  }

  function updateScatterPlot(timeFilter) {
    currentTimeFilter = timeFilter;

    // Recompute station traffic for the selected time window
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Bigger circles when filtering, since there are fewer trips
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    // Update the scatterplot by adjusting the radius of circles
    circles
      .data(filteredStations, (d) => d.short_name) // Ensure D3 tracks elements correctly
      .join("circle")
      .attr("r", (d) => radiusScale(d.totalTraffic))
      .style("--departure-ratio", departureRatio)
      .select("title")
      .text(titleText);
  }

  timeSlider.addEventListener("input", updateTimeDisplay);
  updateTimeDisplay();

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
    const hourFmt = d3.timeFormat("%-I %p");
    const hourLabel = (h) =>
      `${hourFmt(new Date(2024, 0, 1, h))}–${hourFmt(new Date(2024, 0, 1, h + 1))}`;
    const share = d.totalTraffic ? d.departures / d.totalTraffic : 0.5;
    const when =
      currentTimeFilter === -1
        ? "in March 2024"
        : `within an hour of ${formatTime(currentTimeFilter)}`;

    let html = `
      <h2>${d.name}</h2>
      <p class="muted">${d.short_name} · ${d.capacity} docks</p>
      <p class="total"><strong>${fmt(d.totalTraffic)}</strong> trips ${when}</p>
      <div class="flow-bar" aria-hidden="true">
        <span class="dep" style="width:${share * 100}%"></span>
      </div>
      <dl>
        <dt><i class="swatch dep"></i>Departures</dt><dd>${fmt(d.departures)}</dd>
        <dt><i class="swatch arr"></i>Arrivals</dt><dd>${fmt(d.arrivals)}</dd>
        <dt>Net flow</dt><dd>${netText}</dd>`;

    const details = computeStationDetails(d.short_name, currentTimeFilter);
    if (details) {
      const { memberShare, electricShare, medianMinutes, peakHour, topDestination } =
        details;
      html += `
        <dt>Members</dt><dd>${pct(memberShare)} of departures</dd>
        <dt>E-bikes</dt><dd>${pct(electricShare)} of departures</dd>
        <dt>Typical ride</dt><dd>${Math.round(medianMinutes)} min (median)</dd>`;
      if (currentTimeFilter === -1) {
        html += `<dt>Busiest hour</dt><dd>${hourLabel(peakHour)}</dd>`;
      }
      if (topDestination) {
        const [destId, destCount] = topDestination;
        html += `<dt>Top destination</dt><dd>${stationNames.get(destId) ?? destId} (${fmt(destCount)} trips)</dd>`;
      }
    }

    return html + "</dl>";
  }
});
