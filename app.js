"use strict";

      /* ------------------------------------------------------------------
         Street View Route GIF — fully client-side.
         API key lives only in this page's memory (var S.key); it is sent
         only to Google over HTTPS. Nothing is written to localStorage,
         cookies, or any server.
      ------------------------------------------------------------------ */

      var S = {
        key: "",
        mapsReady: false,
        map: null,
        routeLine: null,
        markers: [],
        dots: [],
        route: null,          // { path:[{lat,lng}], distanceMeters, durationSeconds, description, turns:[{lat,lng,dist,maneuver}], _geom:{cum,total} }
        frames: [],           // { lat,lng, panoLat,panoLng, heading, finalHeading, kind, turnIndex, turnLat,turnLng,turnDist, dist, status,panoId,date,copyright,blob,url, sectionIndex, sectionLabel }
        sections: [],         // { index, startDist, endDist, roadClass, miles, fromLabel, toLabel, label, targetCount, overridden, open }
        sectionFetching: {},
        fetching: false,
        cancelFetch: false,
        generating: false,
        gifUrl: null,
        workerScriptUrl: null,
        _mapsLoadFinish: null // settles the in-flight Maps load (gm_authFailure rejects it)
      };

      function $(id) { return document.getElementById(id); }

      function setMsg(el, text, kind) {
        el.textContent = text || "";
        el.className = "msg " + (kind || "info");
      }

      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = src;
          s.async = true;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error("Failed to load " + src)); };
          document.head.appendChild(s);
        });
      }

      /* ---------------- Step 1: connect with the API key ---------------- */

      var keyInput = $("keyInput"), keyStatus = $("keyStatus"), connectBtn = $("connectBtn");

      $("keyToggle").addEventListener("click", function () {
        var show = keyInput.classList.contains("masked");
        keyInput.classList.toggle("masked", !show);
        this.textContent = show ? "Hide" : "Show";
        this.setAttribute("aria-pressed", show ? "true" : "false");
      });

      window.gm_authFailure = function () {
        S.mapsReady = false;
        // If a Connect attempt is still in flight, fail it right away so
        // the user sees this error on the FIRST click instead of the
        // attempt hanging (or silently needing a second click).
        if (S._mapsLoadFinish) S._mapsLoadFinish(new Error("auth"));
        mapsLoadPromise = null; // a corrected key retries from scratch
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect & load map";
        setMsg(keyStatus,
          "Google rejected this key. Check that the key is correct, billing is enabled, the Maps JavaScript API is on, and any HTTP-referrer restriction allows this page's domain.",
          "error");
      };

      connectBtn.addEventListener("click", function () {
        var key = (keyInput.value || "").replace(/\s+/g, ""); // pasted keys often carry stray spaces/newlines
        if (!key) {
          setMsg(keyStatus, "Paste your Google Maps Platform API key first.", "error");
          $("keyCard").classList.remove("shake");
          void $("keyCard").offsetWidth;
          $("keyCard").classList.add("shake");
          keyInput.focus();
          return;
        }
        S.key = key;
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting…";
        setMsg(keyStatus, "Loading Google Maps…", "info");
        loadGoogleMaps(key).then(function () {
          return initMap();
        }).then(function () {
          S.mapsReady = true;
          connectBtn.textContent = "Connected";
          setMsg(keyStatus, "Connected. Address suggestions and routing are ready — plan your drive in step 2.", "ok");
          initAutocomplete();
        }).catch(function (err) {
          S.mapsReady = false;
          // Drop the cached (rejected) load promise so a later click
          // re-attempts the load instead of replaying this failure.
          if (!err || err.message !== "auth") mapsLoadPromise = null;
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect & load map";
          if (err && err.message === "auth") return; // gm_authFailure already reported
          setMsg(keyStatus,
            "Could not load Google Maps. Check your connection, and that the key is valid with the Maps JavaScript API enabled.",
            "error");
        });
      });

      /* First-click fix. The Maps script is loaded with loading=async, so
         the script tag's onload fires while the async bootstrap is still
         wiring up importLibrary — and a Map constructed in that same
         tick (or into a still-hidden container) fails to render. That
         is why the first Connect click used to fail and the second one
         worked (by then window.google was fully loaded). So: one shared
         load promise for the whole page, resolved only once
         importLibrary("maps") itself resolves, and the map construction
         retries once internally — a valid key connects on click one. */
      var mapsLoadPromise = null;

      function waitMs(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
      }

      function waitForMapsApi(attempt) {
        if (window.google && window.google.maps &&
            typeof window.google.maps.importLibrary === "function") {
          // importLibrary existing is not proof the bootstrap finished:
          // make the "maps" library itself resolve before continuing.
          return window.google.maps.importLibrary("maps").then(function () { return true; });
        }
        if (attempt >= 50) return Promise.reject(new Error("network"));
        return waitMs(100).then(function () { return waitForMapsApi(attempt + 1); });
      }

      function loadGoogleMaps(key) {
        if (mapsLoadPromise) return mapsLoadPromise; // never inject the script twice
        mapsLoadPromise = new Promise(function (resolve, reject) {
          var settled = false;
          function finish(err) {
            if (settled) return;
            settled = true;
            S._mapsLoadFinish = null;
            if (err) reject(err); else resolve();
          }
          // gm_authFailure (above) settles this promise immediately when
          // Google refuses the key, instead of leaving the click hanging.
          S._mapsLoadFinish = finish;
          if (window.google && window.google.maps && window.google.maps.importLibrary) {
            waitForMapsApi(0).then(function () { finish(); }, function (e) { finish(e); });
            return;
          }
          var url = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
                    "&v=weekly&loading=async";
          loadScript(url).then(function () {
            return waitForMapsApi(0);
          }).then(function () { finish(); }, function () { finish(new Error("network")); });
        });
        return mapsLoadPromise;
      }

      function initMap() {
        if (S.map) return Promise.resolve();
        return createMap().catch(function () {
          // Cold first-load race (bootstrap still settling, or the
          // container had no layout yet): retry once internally so the
          // user never has to click Connect a second time.
          return waitMs(350).then(createMap);
        });
      }

      function createMap() {
        return google.maps.importLibrary("maps").then(function (lib) {
          var mapEl = $("map");
          $("mapPlaceholder").hidden = true;
          mapEl.hidden = false;
          return new Promise(function (resolve, reject) {
            // Give the just-unhidden container two frames to gain real
            // dimensions before the Map measures it.
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                try {
                  if (!mapEl.clientWidth || !mapEl.clientHeight) {
                    throw new Error("Map container has no size yet.");
                  }
                  S.map = new lib.Map(mapEl, {
                    center: { lat: 39.5, lng: -98.35 },
                    zoom: 4,
                    mapId: "DEMO_MAP_ID",
                    mapTypeControl: false,
                    streetViewControl: false,
                    fullscreenControl: false
                  });
                  $("mapLegend").hidden = false;
                  // The container was hidden until now — force a resize
                  // so the tiles fill it on first paint.
                  if (google.maps.event && google.maps.event.trigger) {
                    google.maps.event.trigger(S.map, "resize");
                  }
                  resolve();
                } catch (e) { reject(e); }
              });
            });
          });
        });
      }

      /* ---------------- Address autocomplete (Places API, New) ----------------
         Enhancement only: if the Places API is not enabled on the key, the
         fetch throws, suggestions silently stop, and typed text still works
         because the Routes library geocodes address strings itself.        */

      var placesLib = null, placesBroken = false;

      function initAutocomplete() {
        google.maps.importLibrary("places").then(function (lib) {
          placesLib = lib;
          attachAutocomplete($("originInput"), $("originList"));
          attachAutocomplete($("destInput"), $("destList"));
        }).catch(function () { placesBroken = true; });
      }

      function attachAutocomplete(input, list) {
        var token = null, timer = null, items = [], activeIdx = -1, seq = 0;

        function closeList() {
          list.hidden = true;
          list.innerHTML = "";
          items = [];
          activeIdx = -1;
          input.removeAttribute("aria-activedescendant");
        }

        function newToken() {
          try { token = new placesLib.AutocompleteSessionToken(); }
          catch (e) { token = null; }
        }

        input.addEventListener("input", function () {
          input.dataset.place = ""; // typing invalidates a previous pick
          if (!placesLib || placesBroken) return;
          var q = input.value.trim();
          clearTimeout(timer);
          if (q.length < 3) { closeList(); return; }
          timer = setTimeout(function () { fetchSuggestions(q); }, 250);
        });

        function fetchSuggestions(q) {
          if (!token) newToken();
          var mySeq = ++seq;
          placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: q,
            sessionToken: token
          }).then(function (res) {
            if (mySeq !== seq) return;
            var suggestions = (res && res.suggestions) || [];
            items = suggestions.filter(function (s) { return s && s.placePrediction; });
            renderList();
          }).catch(function () {
            placesBroken = true; // Places API not enabled on this key — go silent
            closeList();
          });
        }

        function renderList() {
          list.innerHTML = "";
          activeIdx = -1;
          if (!items.length) { list.hidden = true; return; }
          items.forEach(function (s, i) {
            var p = s.placePrediction;
            var li = document.createElement("li");
            li.id = input.id + "-opt-" + i;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", "false");
            var main = (p.mainText && p.mainText.text) || (p.text && p.text.text) || "";
            var sec = (p.secondaryText && p.secondaryText.text) || "";
            var mainSpan = document.createElement("span");
            mainSpan.textContent = main;
            li.appendChild(mainSpan);
            if (sec && sec !== main) {
              var secSpan = document.createElement("span");
              secSpan.className = "sec";
              secSpan.textContent = sec;
              li.appendChild(secSpan);
            }
            li.addEventListener("mousedown", function (ev) {
              ev.preventDefault();
              pick(i);
            });
            list.appendChild(li);
          });
          list.hidden = false;
        }

        function highlight(i) {
          activeIdx = i;
          Array.prototype.forEach.call(list.children, function (li, j) {
            li.setAttribute("aria-selected", j === i ? "true" : "false");
          });
          if (i >= 0 && list.children[i]) {
            input.setAttribute("aria-activedescendant", list.children[i].id);
            list.children[i].scrollIntoView({ block: "nearest" });
          } else {
            input.removeAttribute("aria-activedescendant");
          }
        }

        function pick(i) {
          var s = items[i];
          if (!s) return;
          var p = s.placePrediction;
          var label = (p.text && p.text.text) ||
                      (((p.mainText || {}).text || "") + ((p.secondaryText || {}).text ? ", " + p.secondaryText.text : ""));
          closeList();
          input.value = label;
          var place = p.toPlace();
          place.fetchFields({ fields: ["location", "formattedAddress"] }).then(function () {
            var loc = null;
            if (place.location) {
              loc = {
                lat: typeof place.location.lat === "function" ? place.location.lat() : place.location.lat,
                lng: typeof place.location.lng === "function" ? place.location.lng() : place.location.lng
              };
            }
            input.dataset.place = loc ? JSON.stringify(loc) : "";
            if (place.formattedAddress) input.value = place.formattedAddress;
          }).catch(function () { input.dataset.place = ""; });
          newToken(); // session ends at selection
          input.focus();
        }

        input.addEventListener("keydown", function (ev) {
          if (list.hidden) return;
          if (ev.key === "ArrowDown") { ev.preventDefault(); highlight(Math.min(activeIdx + 1, items.length - 1)); }
          else if (ev.key === "ArrowUp") { ev.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
          else if (ev.key === "Enter" && activeIdx >= 0) { ev.preventDefault(); pick(activeIdx); }
          else if (ev.key === "Escape") { closeList(); }
        });
        input.addEventListener("blur", function () { setTimeout(closeList, 120); });
      }

      function inputValue(input) {
        if (input.dataset.place) {
          try { return JSON.parse(input.dataset.place); } catch (e) { /* fall through */ }
        }
        return input.value.trim();
      }

      /* ---------------- Step 2: routing ---------------- */

      var interstateRange = $("interstateRange"), interstateVal = $("interstateVal");
      var localRange = $("localRange"), localVal = $("localVal");
      var perTurnRange = $("perTurnRange"), perTurnVal = $("perTurnVal");
      function currentSamplingSettings() {
        return {
          interstatePpm: parseInt(interstateRange.value, 10) || 2,
          localPpm: parseInt(localRange.value, 10) || 5,
          perTurn: Math.max(1, Math.min(9, parseInt(perTurnRange.value, 10) || 3))
        };
      }
      function syncSamplingLabels() {
        interstateVal.textContent = interstateRange.value + " / mi";
        localVal.textContent = localRange.value + " / mi";
        perTurnVal.textContent = perTurnRange.value + " / turn";
      }
      [interstateRange, localRange, perTurnRange].forEach(function (el) {
        el.addEventListener("input", function () {
          syncSamplingLabels();
          syncSectionDefaultsFromGlobal();
          refreshSectionControls();
          updateEstimateDisplay();
          updateFetchBtn();
        });
      });
      syncSamplingLabels();
      $("delaySelect").addEventListener("change", function () {
        refreshSectionControls();
        updateEstimateDisplay();
      });

      $("swapBtn").addEventListener("click", function () {
        var o = $("originInput"), d = $("destInput");
        var tv = o.value, tp = o.dataset.place || "";
        o.value = d.value; o.dataset.place = d.dataset.place || "";
        d.value = tv; d.dataset.place = tp;
      });

      $("routeForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        getDirections();
      });

      function requireConnection() {
        if (S.mapsReady) return true;
        setMsg($("routeStatus"), "Connect your API key in step 1 first.", "error");
        $("keyCard").classList.remove("shake");
        void $("keyCard").offsetWidth;
        $("keyCard").classList.add("shake");
        keyInput.focus();
        return false;
      }

      function getDirections() {
        if (!requireConnection()) return;
        var origin = inputValue($("originInput"));
        var destination = inputValue($("destInput"));
        if (!$("originInput").value.trim() || !$("destInput").value.trim()) {
          setMsg($("routeStatus"), "Enter both a start and a destination.", "error");
          return;
        }
        var btn = $("routeBtn");
        btn.disabled = true;
        btn.textContent = "Routing…";
        setMsg($("routeStatus"), "Asking Google for directions…", "info");
        computeRoute(origin, destination).then(function (route) {
          S.route = route;
          initSectionsForRoute();
          invalidateFrames("Route changed — load the Street View photos for this route.");
          drawRoute(route);
          showRouteStats(route);
          buildFilmstrip();
          updateFetchBtn();
          var turnNote = route.turns && route.turns.length ?
            " " + route.turns.length + " turn" + (route.turns.length === 1 ? "" : "s") + " found — each gets " + currentSamplingSettings().perTurn + " photo" + (currentSamplingSettings().perTurn === 1 ? "" : "s") + " centred on it." : "";
          setMsg($("routeStatus"),
            "Route found" + (route.description ? " via " + route.description : "") + "." + turnNote + " Now load the photos in step 4.",
            "ok");
          $("fetchBtn").disabled = false;
        }).catch(function (err) {
          setMsg($("routeStatus"), routeErrorText(err), "error");
        }).then(function () {
          btn.disabled = false;
          btn.textContent = "Get directions";
        });
      }

      function routeErrorText(err) {
        var m = (err && err.message) || String(err || "");
        if (/LegacyApiNotActivated|Routes API|not enabled|API keys with referer|REQUEST_DENIED|PERMISSION/i.test(m)) {
          return "Google refused the route request. Enable the Routes API (or the legacy Directions API) for this key's project, and check billing and referrer restrictions. Details from Google: " + m;
        }
        if (/ZERO_RESULTS|NOT_FOUND|No route|no route/i.test(m)) {
          return "No driving route found between those places. Check the addresses and try again.";
        }
        if (/OVER_QUERY_LIMIT|quota/i.test(m)) {
          return "This key is over its quota right now. Wait a bit or check the project's quotas.";
        }
        return "Directions failed: " + m;
      }

      /* ---- Turn extraction helpers ----
         Guarantee: EVERY directions step boundary is a turn candidate —
         the start location of every step except the very first one
         (origin) — regardless of maneuver/instruction wording, so a
         merge, a ramp, or any unrecognized phrasing still gets its
         before/after photos. Directions-derived turns are preserved
         independently by processDirectionsTurns(): they are NOT dropped
         for being near the route start/end (only the origin point of
         the first step and the final destination point itself are
         excluded, and the extractors already skip the first step), and
         they are NOT merged for being close together — two distinct
         directions turns 10–50 m apart each keep their own before +
         after pair. Only the same step boundary reported twice (same
         location within ~5 m AND same/equivalent maneuver, e.g. from
         duplicate Routes + Directions lookups) is deduplicated. */
      function extractTurnsFromDirectionsResult(result) {
        var out = [];
        try {
          var r0 = result && result.routes && result.routes[0];
          if (!r0) return out;
          var firstStep = true;
          (r0.legs || []).forEach(function (leg) {
            (leg.steps || []).forEach(function (step) {
              var loc = step.start_location || step.start_lat_lng || step.end_location;
              var lit = toLatLngLiteral(loc);
              if (firstStep) { firstStep = false; return; } // origin is not a turn
              if (lit) out.push({ lat: lit.lat, lng: lit.lng, maneuver: String(step.maneuver || "turn") });
            });
          });
        } catch (e) { /* ignore */ }
        return out;
      }
      function extractTurnsFromRoutesRoute(r) {
        var out = [];
        try {
          var legs = (r && (r.legs || r.routeLegs)) || [];
          var firstStep = true;
          legs.forEach(function (leg) {
            var steps = leg.steps || leg.routeSteps || [];
            steps.forEach(function (step) {
              var man = null;
              if (step.navigationInstruction) {
                man = step.navigationInstruction.maneuver || man;
              }
              if (step.navigation_instruction) {
                man = step.navigation_instruction.maneuver || man;
              }
              if (step.maneuver) man = step.maneuver;
              var loc = null;
              if (step.path && step.path.length) loc = toLatLngLiteral(step.path[0]);
              else if (step.startLocation) loc = toLatLngLiteral(step.startLocation);
              else if (step.start_location) loc = toLatLngLiteral(step.start_location);
              else if (step.startLatLng) loc = toLatLngLiteral(step.startLatLng);
              if (firstStep) { firstStep = false; return; } // origin is not a turn
              if (loc) out.push({ lat: loc.lat, lng: loc.lng, maneuver: String(man || "turn") });
            });
          });
        } catch (e) { /* ignore */ }
        return out;
      }

      function cleanStepText(value) {
        return String(value == null ? "" : value)
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/\s+/g, " ")
          .trim();
      }
      function stepPoint(step, which) {
        if (!step) return null;
        if (step.path && step.path.length) {
          return toLatLngLiteral(which === "end" ? step.path[step.path.length - 1] : step.path[0]);
        }
        var candidates = which === "end"
          ? [step.endLocation, step.end_location, step.endLatLng, step.end_lat_lng]
          : [step.startLocation, step.start_location, step.startLatLng, step.start_lat_lng];
        for (var i = 0; i < candidates.length; i++) {
          var lit = toLatLngLiteral(candidates[i]);
          if (lit) return lit;
        }
        return null;
      }
      function extractStepsFromDirectionsResult(result) {
        var out = [];
        try {
          var r0 = result && result.routes && result.routes[0];
          if (!r0) return out;
          (r0.legs || []).forEach(function (leg) {
            (leg.steps || []).forEach(function (step) {
              out.push({
                start: stepPoint(step, "start") || toLatLngLiteral(step.start_location),
                end: stepPoint(step, "end") || toLatLngLiteral(step.end_location),
                text: cleanStepText(step.instructions || step.html_instructions || ""),
                maneuver: String(step.maneuver || "")
              });
            });
          });
        } catch (e) { /* ignore */ }
        return out;
      }
      function extractStepsFromRoutesRoute(r) {
        var out = [];
        try {
          var legs = (r && (r.legs || r.routeLegs)) || [];
          legs.forEach(function (leg) {
            var steps = leg.steps || leg.routeSteps || [];
            steps.forEach(function (step) {
              var nav = step.navigationInstruction || step.navigation_instruction || {};
              out.push({
                start: stepPoint(step, "start"),
                end: stepPoint(step, "end"),
                text: cleanStepText(nav.instructions || step.instructions || step.html_instructions || ""),
                maneuver: String(nav.maneuver || step.maneuver || "")
              });
            });
          });
        } catch (e) { /* ignore */ }
        return out;
      }
      /* Interstate vs local classification. State is carried along the
         route: a merge/head/continue step that references an Interstate
         (I-<number> or the word Interstate) switches the state on;
         unnamed/continue steps that follow stay interstate. An
         exit/ramp step onto another (non-interstate) road switches it
         back to local. Anything unclassifiable defaults to local. */
      function stepReferencesInterstate(text) {
        return /\bi\s*-\s*\d+\b/i.test(text) || /\binterstate\b/i.test(text);
      }
      function classifyRouteSteps(rawSteps) {
        var state = "local";
        return (rawSteps || []).map(function (s) {
          var text = cleanStepText((s.text || "") + " " + (s.maneuver || "").replace(/_/g, " "));
          var isExitOrRamp = /\bexit\b|\bramp\b|\boff ramp\b/i.test(text + " " + String(s.maneuver || ""));
          var onto = text.match(/\bonto\b(.+)$/i);
          var cls;
          if (state === "interstate" && isExitOrRamp) {
            // Leaving the interstate: local unless the ramp leads
            // onto another interstate.
            cls = onto && stepReferencesInterstate(onto[1]) ? "interstate" : "local";
            state = cls;
          } else if (stepReferencesInterstate(text)) {
            cls = "interstate";
            state = "interstate";
          } else {
            cls = state;
          }
          return { start: s.start || null, end: s.end || null, text: text, maneuver: s.maneuver || "", roadClass: cls };
        });
      }
      /* Build contiguous {startDist,endDist,roadClass} segments covering
         the whole route from the classified steps. Step boundaries are
         snapped onto the route path; adjacent stretches of the same
         class merge. No usable step data -> one local segment. */
      function buildRoadSegments(rawSteps, path, cum, total) {
        if (!path.length || !(total > 0)) return [];
        var classified = classifyRouteSteps(rawSteps).filter(function (s) { return s.start || s.end; });
        if (!classified.length) return [{ startDist: 0, endDist: total, roadClass: "local" }];
        var prevEnd = 0;
        var starts = classified.map(function (s, i) {
          var sd = s.start ? distAlongForPoint(path, cum, s.start) : prevEnd;
          if (i === 0) sd = 0;
          if (sd < prevEnd) sd = prevEnd;
          if (sd > total) sd = total;
          prevEnd = sd;
          return { startDist: sd, roadClass: s.roadClass };
        });
        var segments = [];
        starts.forEach(function (s, i) {
          var end = (i + 1 < starts.length) ? starts[i + 1].startDist : total;
          if (end <= s.startDist) return;
          var last = segments[segments.length - 1];
          if (last && last.roadClass === s.roadClass && Math.abs(last.endDist - s.startDist) < 0.01) {
            last.endDist = end;
          } else {
            segments.push({ startDist: s.startDist, endDist: end, roadClass: s.roadClass });
          }
        });
        if (!segments.length) return [{ startDist: 0, endDist: total, roadClass: "local" }];
        segments[0].startDist = 0;
        segments[segments.length - 1].endDist = total;
        return segments;
      }
      function roadClassAtDist(route, dist) {
        var segs = (route && route.segments) || [];
        for (var i = 0; i < segs.length; i++) {
          if (dist >= segs[i].startDist && dist <= segs[i].endDist) return segs[i].roadClass;
        }
        return segs.length ? segs[segs.length - 1].roadClass : "local";
      }
      function segmentMiles(route) {
        var out = { interstate: 0, local: 0 };
        ((route && route.segments) || []).forEach(function (s) {
          var mi = Math.max(0, s.endDist - s.startDist) / MILE_M;
          if (s.roadClass === "interstate") out.interstate += mi; else out.local += mi;
        });
        if (!route || !route.segments || !route.segments.length) {
          out.local = route ? (route.distanceMeters || 0) / MILE_M : 0;
        }
        return out;
      }

      /* New Routes library first; legacy DirectionsService as fallback for
         older projects where Routes API is not enabled. Turns come from
         every directions step boundary (see the extractors above), merged
         with geometric sharp-bend detections, so every directions turn
         still gets its before/after photos even when its maneuver wording
         is unrecognized or the bend itself is gentle. */
      function computeRoute(origin, destination) {
        return google.maps.importLibrary("routes").then(function (lib) {
          var Route = lib.Route, DirectionsService = lib.DirectionsService;

          function finalize(path, distanceMeters, durationSeconds, description, viewport, turnsRaw, stepsRaw) {
            var cleanPath = (path || []).map(toLatLngLiteral).filter(Boolean);
            // geometry helpers are defined below but hoisted as function declarations
            var geom = buildCum(cleanPath);
            var segments = buildRoadSegments(stepsRaw || [], cleanPath, geom.cum, geom.total);
            // Directions-derived turns are preserved independently:
            // processDirectionsTurns() never drops them for proximity
            // to the route start/end or to another directions turn.
            // Geometric sharp-bend turns are processed separately
            // (their own 60–80 m clustering inside/alongside
            // detectTurnsFromPath) and merged IN only when they are
            // not already the same physical corner as a directions
            // turn (within ~15 m). Geometry merging never deletes or
            // replaces a directions turn, so the total turn-photo
            // count stays exactly 2 × preserved turns.
            var stepTurns = processDirectionsTurns(turnsRaw || [], cleanPath, geom.cum, geom.total);
            var geoTurnsAll = processGeometryTurns(detectTurnsFromPath(cleanPath, geom.cum, geom.total), cleanPath, geom.cum, geom.total);
            var geoTurns = geoTurnsAll.filter(function (g) {
              for (var i = 0; i < stepTurns.length; i++) {
                if (Math.abs(g.dist - stepTurns[i].dist) <= 15 &&
                    haversine({ lat: g.lat, lng: g.lng }, { lat: stepTurns[i].lat, lng: stepTurns[i].lng }) <= 15) {
                  return false; // same physical corner as a directions turn
                }
                if (Math.abs(g.dist - stepTurns[i].dist) <= 15) return false;
              }
              return true;
            });
            var turns = stepTurns.concat(geoTurns);
            turns.sort(function (a, b) { return a.dist - b.dist; });
            turns.forEach(function (t, i) { t.index = i; delete t._src; });
            var route = {
              path: cleanPath,
              distanceMeters: distanceMeters || geom.total,
              durationSeconds: durationSeconds || 0,
              description: description || "",
              viewport: viewport || null,
              turns: turns,
              segments: segments
            };
            route._geom = geom;
            return route;
          }

          function fetchDirectionsData() {
            if (typeof DirectionsService !== "function") return Promise.resolve({ turns: [], steps: [] });
            try {
              var svc = new DirectionsService();
              return svc.route({
                origin: origin,
                destination: destination,
                travelMode: google.maps.TravelMode.DRIVING
              }).then(function (result) {
                return {
                  turns: extractTurnsFromDirectionsResult(result),
                  steps: extractStepsFromDirectionsResult(result)
                };
              }).catch(function () { return { turns: [], steps: [] }; });
            } catch (e) { return Promise.resolve({ turns: [], steps: [] }); }
          }

          var newAttempt;
          if (typeof Route === "function" && typeof Route.computeRoutes === "function") {
            newAttempt = Route.computeRoutes({
              origin: origin,
              destination: destination,
              travelMode: "DRIVING",
              fields: ["path", "distanceMeters", "durationMillis", "viewport", "description", "legs"]
            }).then(function (res) {
              var routes = res && res.routes;
              if (!routes || !routes.length || !routes[0].path || !routes[0].path.length) {
                throw new Error("No route found between those places (ZERO_RESULTS).");
              }
              var r = routes[0];
              var turnsRaw = extractTurnsFromRoutesRoute(r);
              var stepsRaw = extractStepsFromRoutesRoute(r);
              var basePath = r.path;
              var distM = r.distanceMeters || 0;
              var durS = r.durationMillis ? r.durationMillis / 1000 : 0;
              if (turnsRaw.length) {
                return finalize(basePath, distM, durS, r.description || "", r.viewport || null, turnsRaw, stepsRaw);
              }
              // No turn data from Routes — try Directions just for its steps.
              return fetchDirectionsData().then(function (sec) {
                return finalize(basePath, distM, durS, r.description || "", r.viewport || null, sec.turns, sec.steps.length ? sec.steps : stepsRaw);
              });
            });
          } else {
            newAttempt = Promise.reject(new Error("Routes library unavailable"));
          }
          return newAttempt.catch(function (newErr) {
            if (/No route found/.test(newErr.message)) throw newErr;
            if (typeof DirectionsService !== "function") throw newErr;
            var svc = new DirectionsService();
            return svc.route({
              origin: origin,
              destination: destination,
              travelMode: google.maps.TravelMode.DRIVING
            }).then(function (result) {
              var r0 = result && result.routes && result.routes[0];
              if (!r0 || !r0.overview_path || !r0.overview_path.length) {
                throw new Error("No route found between those places (ZERO_RESULTS).");
              }
              var dist = 0, dur = 0;
              (r0.legs || []).forEach(function (leg) {
                if (leg.distance && leg.distance.value) dist += leg.distance.value;
                if (leg.duration && leg.duration.value) dur += leg.duration.value;
              });
              var turnsRaw = extractTurnsFromDirectionsResult(result);
              var stepsRaw = extractStepsFromDirectionsResult(result);
              return finalize(r0.overview_path, dist, dur, r0.summary || "", null, turnsRaw, stepsRaw);
            }).catch(function () { throw newErr; });
          });
        });
      }

      /* Route path points arrive as LatLng, LatLngAltitude, or literals
         depending on the API generation — normalize all of them. */
      function toLatLngLiteral(p) {
        if (!p) return null;
        if (typeof p.toLatLng === "function") {
          try { var q = p.toLatLng(); return { lat: q.lat(), lng: q.lng() }; } catch (e) { /* continue */ }
        }
        var lat = typeof p.lat === "function" ? p.lat() : p.lat;
        var lng = typeof p.lng === "function" ? p.lng() : p.lng;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        return { lat: lat, lng: lng };
      }

      function drawRoute(route) {
        if (!S.map) return;
        if (S.routeLine) { S.routeLine.setMap(null); S.routeLine = null; }
        S.markers.forEach(function (m) { m.map = null; });
        S.markers = [];
        clearDots();
        S.routeLine = new google.maps.Polyline({
          path: route.path,
          strokeColor: "#dd9200",
          strokeOpacity: 0.95,
          strokeWeight: 5,
          map: S.map
        });
        var bounds = new google.maps.LatLngBounds();
        route.path.forEach(function (p) { bounds.extend(p); });
        S.map.fitBounds(route.viewport || bounds, 40);
        google.maps.importLibrary("marker").then(function (lib) {
          if (!lib.AdvancedMarkerElement || !S.map) return;
          var start = new lib.AdvancedMarkerElement({
            map: S.map, position: route.path[0], title: "Start"
          });
          var end = new lib.AdvancedMarkerElement({
            map: S.map, position: route.path[route.path.length - 1], title: "Destination"
          });
          S.markers = [start, end];
        }).catch(function () { /* markers are decoration; the line is the content */ });
      }

      function showRouteStats(route) {
        $("routeStats").hidden = false;
        $("statDist").textContent = fmtDistance(route.distanceMeters) + " (" + (route.distanceMeters / 1609.344).toFixed(2) + " mi)";
        $("statDur").textContent = route.durationSeconds ? fmtDuration(route.durationSeconds) : "–";
        updateEstimateDisplay();
      }

      var MILE_M = 1609.344;
      var TURN_OFFSET_M = 45;

      function currentDelaySec() {
        var v = parseInt($("delaySelect").value, 10);
        return isNaN(v) ? 0.25 : v / 1000;
      }
      function fmtGifLength(sec) {
        if (!isFinite(sec)) return "–";
        if (sec < 60) return "≈ " + (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + " s";
        var m = Math.floor(sec / 60), s = Math.round(sec % 60);
        return "≈ " + m + " min" + (s ? " " + s + " s" : "");
      }
      function estimateForRoute(route, settings) {
        if (!route || !route.path || !route.path.length) return null;
        var samples = buildRouteSamples(route, settings);
        var interstatePhotos = 0, localPhotos = 0, guaranteedPhotos = 0, turnPhotos = 0;
        samples.forEach(function (s) {
          if (s.kind === "section") guaranteedPhotos++;
          else if (s.kind === "route") { if (s.roadClass === "interstate") interstatePhotos++; else localPhotos++; }
          else turnPhotos++;
        });
        var segMi = segmentMiles(route);
        var delaySec = currentDelaySec();
        return {
          miles: route.distanceMeters / MILE_M,
          interstateMiles: segMi.interstate,
          localMiles: segMi.local,
          settings: settings,
          interstatePhotos: interstatePhotos,
          localPhotos: localPhotos,
          guaranteedPhotos: guaranteedPhotos,
          routePhotos: interstatePhotos + localPhotos,
          turnPhotos: turnPhotos,
          turns: (route.turns || []).length,
          total: samples.length,
          gifSec: samples.length * delaySec,
          delaySec: delaySec,
          samples: samples
        };
      }

      var GIF_BYTES_PER_FRAME = 95 * 1024; // ~95 KB per 640×360 GIF frame encoded (quality 10) — an estimate; actual varies with scene detail
      function estimateGifSizeMB(frameCount) {
        return (frameCount * GIF_BYTES_PER_FRAME) / 1048576;
      }
      function fmtGifSize(frameCount) {
        var mb = estimateGifSizeMB(frameCount);
        if (frameCount <= 0) return "–";
        if (mb < 1) return "~" + Math.round(mb * 1024) + " KB (estimate)";
        return "~" + mb.toFixed(mb >= 10 ? 1 : 2) + " MB (estimate)";
      }
      function fmtGifSizeShort(frameCount) {
        var mb = estimateGifSizeMB(frameCount);
        if (mb < 1) return "~" + Math.round(mb * 1024) + " KB";
        return "~" + mb.toFixed(mb >= 10 ? 1 : 2) + " MB";
      }

      /* Sections: stretches between turns, split where road class changes.
         Boundaries are Start (0), each turn distance, Destination (total).
         Each resulting homogeneous stretch is one section. */
      function computeSections(route) {
        if (!route || !route.path || !route.path.length) return [];
        var geom = getRouteGeom(route);
        var total = geom.total;
        var turns = (route.turns || []).slice().sort(function (a, b) { return a.dist - b.dist; });
        var boundaries = [0];
        turns.forEach(function (t) {
          if (t.dist > 0.01 && t.dist < total - 0.01) boundaries.push(t.dist);
        });
        boundaries.push(total);
        // de-dupe near-identical boundaries
        boundaries = boundaries.filter(function (d, i) { return i === 0 || Math.abs(d - boundaries[i - 1]) > 0.5; });
        var roadSegs = (route.segments && route.segments.length)
          ? route.segments
          : [{ startDist: 0, endDist: total, roadClass: "local" }];
        var sections = [];
        for (var bi = 0; bi + 1 < boundaries.length; bi++) {
          var lo = boundaries[bi], hi = boundaries[bi + 1];
          if (!(hi > lo)) continue;
          var fromLabel = bi === 0 ? "Start" : "Turn " + bi;
          var toLabel = (bi === boundaries.length - 2) ? "Destination" : "Turn " + (bi + 1);
          // split by road class
          var subs = [];
          roadSegs.forEach(function (rs) {
            var s = Math.max(lo, rs.startDist), e = Math.min(hi, rs.endDist);
            if (e > s + 0.01) subs.push({ startDist: s, endDist: e, roadClass: rs.roadClass });
          });
          if (!subs.length) subs = [{ startDist: lo, endDist: hi, roadClass: roadClassAtDist(route, (lo + hi) / 2) }];
          // merge adjacent same-class (safety)
          var merged = [];
          subs.forEach(function (s) {
            var last = merged[merged.length - 1];
            if (last && last.roadClass === s.roadClass && Math.abs(last.endDist - s.startDist) < 0.02) last.endDist = s.endDist;
            else merged.push({ startDist: s.startDist, endDist: s.endDist, roadClass: s.roadClass });
          });
          merged.forEach(function (m) {
            var miles = Math.max(0, m.endDist - m.startDist) / MILE_M;
            var idx = sections.length;
            var rcLabel = m.roadClass === "interstate" ? "Interstate" : "Local";
            sections.push({
              index: idx,
              startDist: m.startDist,
              endDist: m.endDist,
              roadClass: m.roadClass,
              miles: miles,
              fromLabel: fromLabel,
              toLabel: toLabel,
              label: "Section " + (idx + 1) + " · " + rcLabel + " · " + miles.toFixed(2) + " mi · " + fromLabel + " → " + toLabel,
              targetCount: 1,
              overridden: false,
              open: false
            });
          });
        }
        return sections;
      }
      function sectionIndexForDist(dist) {
        if (!S.sections || !S.sections.length) return -1;
        for (var i = 0; i < S.sections.length; i++) {
          var s = S.sections[i];
          if (dist >= s.startDist - 0.01 && (dist < s.endDist - 0.01 || i === S.sections.length - 1)) return i;
        }
        return S.sections.length - 1;
      }
      function assignSectionToFrame(f) {
        var idx = sectionIndexForDist(f.dist != null ? f.dist : 0);
        f.sectionIndex = idx;
        f.sectionLabel = (idx >= 0 && S.sections[idx]) ? S.sections[idx].label : null;
        return f;
      }
      function defaultCountsPerSection(route, settings) {
        var samples = buildRouteSamples(route, settings);
        var counts = S.sections.map(function () { return 0; });
        samples.forEach(function (s) {
          if (s.kind === "route" || s.kind === "section") {
            var idx = sectionIndexForDist(s.dist);
            if (idx >= 0) counts[idx]++;
          }
        });
        // guarantee at least 1 per section
        return counts.map(function (c) { return Math.max(1, c); });
      }
      function initSectionsForRoute() {
        S.sections = computeSections(S.route);
        if (S.route && S.sections.length) {
          var defaults = defaultCountsPerSection(S.route, currentSamplingSettings());
          S.sections.forEach(function (sec, i) {
            sec.targetCount = Math.max(1, Math.min(100, defaults[i] || 1));
            sec.overridden = false;
            sec.open = false;
          });
        }
        S.sectionFetching = {};
      }
      function syncSectionDefaultsFromGlobal() {
        if (!S.route || !S.sections.length) return;
        var defaults = defaultCountsPerSection(S.route, currentSamplingSettings());
        S.sections.forEach(function (sec, i) {
          if (!sec.overridden) sec.targetCount = Math.max(1, Math.min(100, defaults[i] || 1));
        });
      }
      function sectionCounts(idx) {
        var loaded = 0, filtered = 0, nocov = 0, total = 0, pending = 0;
        S.frames.forEach(function (f) {
          if (f.sectionIndex !== idx) return;
          total++;
          if (f.status === "ok") loaded++;
          else if (f.status === "filtered") filtered++;
          else if (f.status === "nocov" || f.status === "error") nocov++;
          else pending++;
        });
        return { loaded: loaded, filtered: filtered, nocov: nocov, total: total, pending: pending };
      }
      function totalPlannedFrames() {
        if (S.frames && S.frames.length) {
          var ok = S.frames.filter(function (f) { return f.status === "ok"; }).length;
          if (ok > 0) return { count: ok, fromActual: true, totalSamples: S.frames.length };
        }
        if (S.sections && S.sections.length) {
          var turnCount = (S.route && S.route.turns ? S.route.turns.length : 0) * currentSamplingSettings().perTurn;
          var secSum = S.sections.reduce(function (a, s) { return a + (s.targetCount || 0); }, 0);
          // if frames already sampled but none loaded yet, use frame length as planned
          if (S.frames && S.frames.length) return { count: S.frames.length, fromActual: false, totalSamples: S.frames.length };
          return { count: secSum + turnCount, fromActual: false, totalSamples: secSum + turnCount };
        }
        return null;
      }

      function updateEstimateDisplay() {
        var settings = currentSamplingSettings();
        var estEl = $("frameEstimate");
        if (!S.route) {
          if (estEl) estEl.textContent = "Get directions to see how many photos this will make — interstate miles × " + settings.interstatePpm + "/mi + local miles × " + settings.localPpm + "/mi + one guaranteed photo between turns + " + settings.perTurn + " per turn.";
          if ($("statInterstate")) $("statInterstate").textContent = "–";
          if ($("statLocal")) $("statLocal").textContent = "–";
          if ($("statTurns")) $("statTurns").textContent = "–";
          if ($("statPhotos")) $("statPhotos").textContent = "–";
          if ($("statGif")) $("statGif").textContent = "–";
          if ($("statGifSize")) $("statGifSize").textContent = "–";
          if ($("statSpace")) $("statSpace").textContent = "–";
          return;
        }
        var est = estimateForRoute(S.route, settings);
        if (!est) return;
        // Planned total honours per-section overrides once sections exist
        var planned = totalPlannedFrames();
        var displayTotal = planned ? planned.count : est.total;
        var displayGifSec = displayTotal * currentDelaySec();
        var hasActual = planned && planned.fromActual;
        if (estEl) {
          var warn = displayTotal > 250 ? " That is a lot of billed photo requests and a large GIF — lower photos/mi for long routes." : "";
          var actualNote = hasActual ? " Using " + displayTotal + " loaded photo" + (displayTotal === 1 ? "" : "s") + " for the GIF estimates." : "";
          estEl.textContent =
            "≈ " + displayTotal + " photos · " + est.interstatePhotos + " interstate (" + est.interstateMiles.toFixed(2) + " mi × " + settings.interstatePpm + "/mi)" +
            " + " + est.localPhotos + " local (" + est.localMiles.toFixed(2) + " mi × " + settings.localPpm + "/mi)" +
            " + " + est.guaranteedPhotos + " between-turns" +
            " + " + est.turnPhotos + " turn (" + est.turns + " turn" + (est.turns === 1 ? "" : "s") + " × " + settings.perTurn + ")" +
            " → " + fmtGifLength(displayGifSec) + " GIF at " + currentDelaySec() + "s/frame." + actualNote + " Headings face the direction of travel; turn photos face into/through/out of each turn, snapped to each panorama." + warn;
        }
        if ($("statInterstate")) $("statInterstate").textContent = est.interstateMiles.toFixed(2) + " mi";
        if ($("statLocal")) $("statLocal").textContent = est.localMiles.toFixed(2) + " mi";
        if ($("statTurns")) $("statTurns").textContent = String(est.turns);
        if ($("statPhotos")) $("statPhotos").textContent = hasActual
          ? displayTotal + " loaded (" + planned.totalSamples + " samples)"
          : "≈ " + displayTotal + " (" + est.interstatePhotos + " I + " + est.localPhotos + " L + " + est.guaranteedPhotos + " between + " + est.turnPhotos + " turn)";
        if ($("statGif")) $("statGif").textContent = fmtGifLength(displayGifSec) + " @ " + currentDelaySec() + "s";
        if ($("statGifSize")) $("statGifSize").textContent = fmtGifSize(displayTotal);
        if ($("statSpace")) {
          $("statSpace").textContent = "I " + settings.interstatePpm + "/mi · L " + settings.localPpm + "/mi · " + settings.perTurn + "/turn";
        }
      }

      function fmtDistance(m) {
        if (!m && m !== 0) return "–";
        if (m >= 1000) return (m / 1000).toFixed(m >= 100000 ? 0 : 1) + " km";
        return Math.round(m) + " m";
      }

      function fmtDuration(sec) {
        var mins = Math.round(sec / 60);
        if (mins < 60) return mins + " min";
        var h = Math.floor(mins / 60), r = mins % 60;
        return h + " h" + (r ? " " + r + " min" : "");
      }

      /* ---------------- Path sampling & headings ---------------- */

      var EARTH_R = 6371000;
      function toRad(d) { return d * Math.PI / 180; }

      function haversine(a, b) {
        var dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
      }

      function bearing(a, b) {
        var dLng = toRad(b.lng - a.lng);
        var y = Math.sin(dLng) * Math.cos(toRad(b.lat));
        var x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
                Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      }

      /* ---- Route geometry ---- */
      function buildCum(path) {
        var cum = [0];
        for (var i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
        return { cum: cum, total: cum.length ? cum[cum.length - 1] : 0 };
      }
      function getRouteGeom(route) {
        if (!route) return { cum: [0], total: 0 };
        if (route._geom && route._geom.cum && route._geom.cum.length === route.path.length) return route._geom;
        route._geom = buildCum(route.path);
        return route._geom;
      }
      function pointAtDist(path, cum, total, d) {
        if (!path.length) return { lat: 0, lng: 0 };
        if (d <= 0) return path[0];
        if (d >= total) return path[path.length - 1];
        var lo = 0, hi = cum.length - 1;
        while (lo < hi - 1) {
          var mid = (lo + hi) >> 1;
          if (cum[mid] <= d) lo = mid; else hi = mid;
        }
        var seg = cum[hi] - cum[lo];
        var t = seg === 0 ? 0 : (d - cum[lo]) / seg;
        return {
          lat: path[lo].lat + (path[hi].lat - path[lo].lat) * t,
          lng: path[lo].lng + (path[hi].lng - path[lo].lng) * t
        };
      }
      function distAlongForPoint(path, cum, pt) {
        var best = 0, bestD = Infinity;
        for (var i = 0; i < path.length; i++) {
          var d = haversine(path[i], pt);
          if (d < bestD) { bestD = d; best = i; }
        }
        return cum[best];
      }
      function smallestAngleDiff(a, b) {
        var d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
      }
      function detectTurnsFromPath(path, cum, total) {
        var candidates = [];
        for (var i = 1; i < path.length - 1; i++) {
          var d1 = cum[i] - cum[i - 1], d2 = cum[i + 1] - cum[i];
          if (d1 < 12 || d2 < 12) continue;
          var b1 = bearing(path[i - 1], path[i]);
          var b2 = bearing(path[i], path[i + 1]);
          var diff = smallestAngleDiff(b1, b2);
          if (diff > 24) candidates.push({ lat: path[i].lat, lng: path[i].lng, maneuver: "turn", _angle: diff, _dist: cum[i] });
        }
        // cluster within 80 m, keep sharpest
        candidates.sort(function (a, b) { return a._dist - b._dist; });
        var clustered = [];
        candidates.forEach(function (c) {
          var last = clustered[clustered.length - 1];
          if (last && Math.abs(c._dist - last._dist) < 80) {
            if (c._angle > last._angle) clustered[clustered.length - 1] = c;
          } else clustered.push(c);
        });
        return clustered.map(function (c) { return { lat: c.lat, lng: c.lng, maneuver: "turn" }; });
      }
      function normalizeManeuver(m) {
        return String(m || "turn").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "turn";
      }
      function maneuverCanonical(m) {
        var n = normalizeManeuver(m);
        if (/\buturn\b|\bu turn\b/.test(n)) return "uturn";
        if (/\bleft\b/.test(n)) return "left";
        if (/\bright\b/.test(n)) return "right";
        if (/\bstraight\b|\bcontinue\b|\bhead\b|\bkeep\b/.test(n)) return "straight";
        if (/\bmerge\b/.test(n)) return "merge";
        if (/\bramp\b|\bexit\b|\bon ramp\b|\boff ramp\b/.test(n)) return "ramp";
        if (/\bfork\b/.test(n)) return "fork";
        if (/\broundabout\b|\brotary\b/.test(n)) return "roundabout";
        return n;
      }
      function maneuversEquivalent(a, b) {
        var na = normalizeManeuver(a), nb = normalizeManeuver(b);
        if (na === nb) return true;
        // The extractors default a missing maneuver to the generic
        // "turn"; treat that as equivalent to any specific maneuver so
        // a duplicate lookup that lacks maneuver detail still dedupes.
        if (na === "turn" || nb === "turn") return true;
        var ca = maneuverCanonical(a), cb = maneuverCanonical(b);
        return ca !== "" && ca === cb;
      }
      /* Directions-derived turns: preserved independently.
         - NO 20 m start/end exclusion: only a point that IS the origin
           (distance exactly 0) or IS the final destination (distance
           exactly total) is excluded. The extractors already skip the
           first step's start (the origin); this guards duplicate
           reports of those exact endpoints.
         - NO proximity merging: distinct directions turns 10–50 m
           apart each survive with their own before/after pair.
         - Dedupe ONLY the same step boundary reported twice: same
           location within ~5 m AND same/equivalent maneuver. */
      function processDirectionsTurns(raw, path, cum, total) {
        if (!raw || !raw.length || !path.length) return [];
        var mapped = raw.map(function (t) {
          return { lat: t.lat, lng: t.lng, maneuver: t.maneuver || "turn", dist: distAlongForPoint(path, cum, t) };
        });
        mapped.sort(function (a, b) { return a.dist - b.dist; });
        var out = [];
        mapped.forEach(function (t) {
          if (t.dist <= 0 || t.dist >= total) return; // exactly origin / exactly destination only
          var isDup = false;
          for (var i = 0; i < out.length; i++) {
            var keptTurn = out[i];
            if (Math.abs(t.dist - keptTurn.dist) <= 5 &&
                haversine({ lat: t.lat, lng: t.lng }, { lat: keptTurn.lat, lng: keptTurn.lng }) <= 5 &&
                maneuversEquivalent(t.maneuver, keptTurn.maneuver)) {
              isDup = true;
              break;
            }
          }
          if (isDup) return;
          out.push(t);
        });
        out.forEach(function (t, i) { t.index = i; });
        return out;
      }
      /* Geometric sharp-bend turns: may still be clustered/merged
         separately (detectTurnsFromPath clusters within 80 m keeping
         the sharpest; this pass merges within 70 m, inside the 60–80 m
         band) and keeps the 20 m start/end exclusion, which applies
         ONLY to geometry-derived candidates — never to directions
         turns. */
      function processGeometryTurns(raw, path, cum, total) {
        if (!raw || !raw.length || !path.length) return [];
        var mapped = raw.map(function (t) {
          return { lat: t.lat, lng: t.lng, maneuver: t.maneuver || "turn", dist: distAlongForPoint(path, cum, t) };
        });
        mapped.sort(function (a, b) { return a.dist - b.dist; });
        var out = [];
        mapped.forEach(function (t) {
          if (t.dist < 20 || t.dist > total - 20) return; // geometry-only start/end guard
          var last = out[out.length - 1];
          if (last && Math.abs(t.dist - last.dist) < 70) return; // geometry-only clustering
          out.push(t);
        });
        out.forEach(function (t, i) { t.index = i; });
        return out;
      }
      /* Backwards-compatible alias: the old single entry point now has
         directions-turn semantics (the strict-preservation behaviour),
         since directions turns are the ones the guarantee covers. */
      function processTurns(raw, path, cum, total) {
        return processDirectionsTurns(raw, path, cum, total);
      }

      /* Heading helpers — critical: never average across a corner.
         - incomingHeading uses ONLY points before the turn.
         - outgoingHeading uses ONLY points after the turn.
         - route (base) heading looks ahead, but if the lookahead would
           cross the next turn, it stops at the turn point instead. */
      function incomingHeading(path, cum, total, turnDist) {
        var a = pointAtDist(path, cum, total, Math.max(0, turnDist - 55));
        var b = pointAtDist(path, cum, total, Math.max(0, turnDist - 2));
        if (haversine(a, b) < 3) {
          a = pointAtDist(path, cum, total, Math.max(0, turnDist - 90));
          b = pointAtDist(path, cum, total, Math.max(0, turnDist - 5));
        }
        return bearing(a, b);
      }
      function midHeading(path, cum, total, turnDist) {
        var a = pointAtDist(path, cum, total, Math.max(0, Math.min(total, turnDist)));
        var b = pointAtDist(path, cum, total, Math.min(total, turnDist + 30));
        if (haversine(a, b) < 3) {
          b = pointAtDist(path, cum, total, Math.min(total, turnDist + 60));
        }
        if (haversine(a, b) < 3) return outgoingHeading(path, cum, total, turnDist);
        return bearing(a, b);
      }
      function outgoingHeading(path, cum, total, turnDist) {
        var a = pointAtDist(path, cum, total, Math.min(total, turnDist + 2));
        var b = pointAtDist(path, cum, total, Math.min(total, turnDist + 55));
        if (haversine(a, b) < 3) {
          a = pointAtDist(path, cum, total, Math.min(total, turnDist + 5));
          b = pointAtDist(path, cum, total, Math.min(total, turnDist + 90));
        }
        return bearing(a, b);
      }
      function routeHeading(path, cum, total, dist, turns) {
        var p = pointAtDist(path, cum, total, dist);
        // If next turn is within lookahead, face the turn (incoming road), don't cut the corner.
        var nextTurn = null;
        if (turns) {
          for (var i = 0; i < turns.length; i++) {
            if (turns[i].dist > dist + 1) { nextTurn = turns[i]; break; }
          }
        }
        var look = 60;
        if (nextTurn && (nextTurn.dist - dist) < look && (nextTurn.dist - dist) > 4) {
          var tp = { lat: nextTurn.lat, lng: nextTurn.lng };
          if (haversine(p, tp) > 4) return bearing(p, tp);
          return incomingHeading(path, cum, total, nextTurn.dist);
        }
        if (dist >= total - 4) {
          var behind = pointAtDist(path, cum, total, Math.max(0, total - look));
          if (haversine(behind, p) > 4) return bearing(behind, p);
          return bearing(pointAtDist(path, cum, total, Math.max(0, dist - look)), p);
        }
        var ahead = pointAtDist(path, cum, total, Math.min(total, dist + look));
        if (haversine(p, ahead) < 4) {
          var behind2 = pointAtDist(path, cum, total, Math.max(0, dist - look));
          return bearing(behind2, p);
        }
        return bearing(p, ahead);
      }

      /* Build the full sample list:
         - Regular photos are sampled WITHIN each classified stretch:
           interstate segments at interstatePpm, local segments at
           localPpm, so a density change takes effect exactly at the
           highway boundary (plus a photo at each route endpoint).
         - Every turn gets perTurn photos centred on the turn, ~45 m
           apart: offsets (i - (N-1)/2) * 45 m, clamped to the route.
           N=3 reproduces before(-45)/mid(0)/after(+45); negative
           offsets face the incoming heading, zero faces through the
           turn, positive offsets face the outgoing heading.
         - Finally, the route is split into sections by consecutive
           turns (start -> first turn, ..., last turn -> destination);
           any section with NO regular photo strictly between its
           boundaries gets one guaranteed photo at its midpoint
           (kind "section"), regardless of ppm. Turn photos never
           count as the between-turns photo.
         Turn frames keep the strict-preservation dedupe: only an
         exact duplicate (same turn, same kind, same distance) is
         dropped, and only regular photos within ~14 m of a turn
         photo are dropped — guaranteed "section" photos are added
         after that dedupe, so they are never removed by it. */
      function normalizeSamplingSettings(settings) {
        if (typeof settings === "number") {
          return { interstatePpm: settings, localPpm: settings, perTurn: 3 };
        }
        settings = settings || {};
        return {
          interstatePpm: Math.max(1, settings.interstatePpm || settings.localPpm || 5),
          localPpm: Math.max(1, settings.localPpm || 5),
          perTurn: Math.max(1, Math.min(9, settings.perTurn || 3))
        };
      }
      function buildRouteSamples(route, settingsIn) {
        if (!route || !route.path || !route.path.length) return [];
        var settings = normalizeSamplingSettings(settingsIn);
        var path = route.path;
        var geom = getRouteGeom(route);
        var cum = geom.cum, total = geom.total;
        if (total === 0 || path.length === 1) {
          return [{ lat: path[0].lat, lng: path[0].lng, heading: 0, dist: 0, kind: "route", roadClass: "local", turnIndex: -1, turnLat: null, turnLng: null, turnDist: null, turnOffsetM: null }];
        }
        var candidates = [];
        function addCandidate(dist, kind, ti, tLat, tLng, tDist, offsetM) {
          dist = Math.max(0, Math.min(total, dist));
          candidates.push({
            dist: dist, kind: kind,
            turnIndex: (ti != null ? ti : -1),
            turnLat: (tLat != null ? tLat : null),
            turnLng: (tLng != null ? tLng : null),
            turnDist: (tDist != null ? tDist : null),
            turnOffsetM: (offsetM != null ? offsetM : null),
            roadClass: roadClassAtDist(route, dist)
          });
        }
        // Regular photos, sampled per classified segment.
        var segments = (route.segments && route.segments.length)
          ? route.segments
          : [{ startDist: 0, endDist: total, roadClass: "local" }];
        addCandidate(0, "route", -1);
        segments.forEach(function (seg) {
          var ppm = seg.roadClass === "interstate" ? settings.interstatePpm : settings.localPpm;
          var spacing = MILE_M / ppm;
          var len = seg.endDist - seg.startDist;
          if (!(len > 0) || !(spacing > 0)) return;
          for (var d = seg.startDist + spacing / 2; d < seg.endDist - spacing * 0.2; d += spacing) {
            addCandidate(d, "route", -1);
          }
        });
        addCandidate(total, "route", -1);
        // Turn photos: perTurn positions centred on the turn.
        var turns = route.turns || [];
        var n = settings.perTurn;
        turns.forEach(function (t, ti) {
          for (var i = 0; i < n; i++) {
            var offset = (i - (n - 1) / 2) * TURN_OFFSET_M;
            var kind = offset < -0.001 ? "before-turn" : (offset > 0.001 ? "after-turn" : "mid-turn");
            addCandidate(t.dist + offset, kind, ti, t.lat, t.lng, t.dist, offset);
          }
        });
        candidates.sort(function (a, b) { return a.dist - b.dist; });
        // Dedupe: regular photo dropped only within ~14 m of a turn
        // photo; turn photo dropped only on an exact duplicate
        // (same turn + same kind + same distance, e.g. after clamping
        // at a route endpoint). Regular photos are not deduped
        // against each other.
        var turnCandidates = candidates.filter(function (c) { return c.kind !== "route"; });
        var kept = [];
        candidates.forEach(function (c) {
          if (c.kind === "route") {
            var nearTurn = false;
            for (var i = 0; i < turnCandidates.length; i++) {
              if (Math.abs(c.dist - turnCandidates[i].dist) < 14) { nearTurn = true; break; }
            }
            if (nearTurn) return;
            kept.push(c);
            return;
          }
          var isExactDup = false;
          for (var j = 0; j < kept.length; j++) {
            var k = kept[j];
            if (k.kind === c.kind && k.turnIndex === c.turnIndex && Math.abs(k.dist - c.dist) < 1) {
              isExactDup = true;
              break;
            }
          }
          if (isExactDup) return;
          kept.push(c);
        });
        // At-least-one-between-turns guarantee (runs after dedupe, and
        // guaranteed photos are never deduped away themselves).
        var boundaries = [0];
        turns.forEach(function (t) {
          if (t.dist > 0 && t.dist < total) boundaries.push(t.dist);
        });
        boundaries.push(total);
        boundaries = boundaries.filter(function (d, i) { return i === 0 || Math.abs(d - boundaries[i - 1]) > 0.01; });
        for (var b = 0; b + 1 < boundaries.length; b++) {
          var lo = boundaries[b], hi = boundaries[b + 1];
          if (!(hi > lo)) continue;
          var hasRegular = false;
          for (var q = 0; q < kept.length; q++) {
            var kc = kept[q];
            if ((kc.kind === "route" || kc.kind === "section") && kc.dist > lo + 0.01 && kc.dist < hi - 0.01) {
              hasRegular = true;
              break;
            }
          }
          if (!hasRegular) {
            var midDist = (lo + hi) / 2;
            kept.push({
              dist: midDist, kind: "section",
              turnIndex: -1, turnLat: null, turnLng: null, turnDist: null, turnOffsetM: null,
              roadClass: roadClassAtDist(route, midDist)
            });
          }
        }
        kept.sort(function (a, b) { return a.dist - b.dist; });
        // Map to lat/lng + corner-safe heading
        return kept.map(function (c) {
          var p = pointAtDist(path, cum, total, c.dist);
          var h;
          if (c.kind === "before-turn" && c.turnDist != null) {
            h = incomingHeading(path, cum, total, c.turnDist);
          } else if (c.kind === "mid-turn" && c.turnDist != null) {
            h = midHeading(path, cum, total, c.turnDist);
          } else if (c.kind === "after-turn" && c.turnDist != null) {
            h = outgoingHeading(path, cum, total, c.turnDist);
          } else {
            h = routeHeading(path, cum, total, c.dist, turns);
          }
          return {
            lat: p.lat, lng: p.lng, heading: h, dist: c.dist,
            kind: c.kind, roadClass: c.roadClass || roadClassAtDist(route, c.dist),
            turnIndex: (c.turnIndex != null ? c.turnIndex : -1),
            turnLat: (c.turnLat != null ? c.turnLat : null),
            turnLng: (c.turnLng != null ? c.turnLng : null),
            turnDist: (c.turnDist != null ? c.turnDist : null),
            turnOffsetM: (c.turnOffsetM != null ? c.turnOffsetM : null)
          };
        });
      }

      /* Legacy helper kept for compatibility — now delegates to the
         per-mile sampler without turn photos would be wrong, so callers
         should use buildRouteSamples. This remains only if referenced. */
      function samplePath(path, n) {
        // n is treated as total count fallback; convert to a one-off route shim
        var shim = { path: path, distanceMeters: 0, turns: [] };
        var geom = buildCum(path);
        shim._geom = geom;
        shim.distanceMeters = geom.total;
        var ppm = geom.total > 0 ? (n / (geom.total / MILE_M)) : 5;
        return buildRouteSamples(shim, ppm);
      }

      /* ---------------- Step 4: Street View metadata + images ---------------- */

      var fetchBtn = $("fetchBtn"), fetchStatus = $("fetchStatus"), fetchBar = $("fetchBar");

      function updateFetchBtn() {
        if (!S.route) {
          fetchBtn.textContent = "Load Street View photos";
          return;
        }
        var est = estimateForRoute(S.route, currentSamplingSettings());
        if (est) {
          fetchBtn.textContent = "Load ≈ " + est.total + " photos (" + est.interstatePhotos + " interstate + " + est.localPhotos + " local + " + est.guaranteedPhotos + " between + " + est.turnPhotos + " turn)";
        } else {
          fetchBtn.textContent = "Load Street View photos";
        }
      }
      updateFetchBtn();

      function clearDots() {
        S.dots.forEach(function (c) { c.setMap(null); });
        S.dots = [];
      }

      function drawDots() {
        clearDots();
        if (!S.map || !S.frames.length) return;
        var radius = S.route ? Math.min(400, Math.max(15, S.route.distanceMeters * 0.004)) : 60;
        S.frames.forEach(function (f) {
          var isTurn = isTurnFrame(f);
          var c = new google.maps.Circle({
            map: S.map,
            center: { lat: f.lat, lng: f.lng },
            radius: isTurn ? radius * 1.35 : radius,
            strokeWeight: isTurn ? 2 : 1,
            strokeColor: isTurn ? "#dd9200" : "#ffffff",
            fillOpacity: 0.9,
            fillColor: isTurn ? "#dd9200" : "#54687a",
            clickable: false,
            zIndex: isTurn ? 4 : 3
          });
          S.dots.push(c);
        });
      }

      function paintDot(i) {
        var c = S.dots[i], f = S.frames[i];
        if (!c || !f) return;
        var isTurn = isTurnFrame(f);
        if (f.status === "ok") {
          c.setOptions({ fillColor: "#1e7f47", strokeColor: isTurn ? "#dd9200" : "#ffffff", strokeWeight: isTurn ? 2 : 1 });
        } else if (f.status === "filtered") {
          c.setOptions({ fillColor: "#9aa7b3", strokeColor: isTurn ? "#dd9200" : "#ffffff", strokeWeight: isTurn ? 2 : 1 });
        } else if (f.status === "nocov" || f.status === "error") {
          c.setOptions({ fillColor: "#c23737", strokeColor: isTurn ? "#dd9200" : "#ffffff", strokeWeight: isTurn ? 2 : 1 });
        } else {
          c.setOptions({ fillColor: isTurn ? "#dd9200" : "#54687a" });
        }
      }

      function invalidateFrames(reason) {
        S.frames.forEach(function (f) { if (f.url) URL.revokeObjectURL(f.url); });
        S.frames = [];
        var secWrap = $("filmSections");
        if (secWrap) secWrap.innerHTML = "";
        // Keep the Frames card visible once a route exists so sections
        // (collapsed by default) and their re-fetch controls are usable
        // even before any photos are loaded.
        $("filmCard").hidden = !S.route;
        var dbgBtn = $("copyDebugBtn");
        if (dbgBtn) dbgBtn.disabled = true;
        var dbgStatus = $("copyDebugStatus");
        if (dbgStatus) { dbgStatus.textContent = ""; dbgStatus.className = "copy-status"; }
        clearDots();
        $("gifBtn").disabled = true;
        if (reason) setMsg(fetchStatus, reason, "info");
        if (S.gifUrl) { URL.revokeObjectURL(S.gifUrl); S.gifUrl = null; }
        $("resultCard").hidden = true;
        updateEstimateDisplay();
      }

      /* Reset samples + filmstrip every time photos are (re)loaded, so a
         slider change followed by a reload replaces the old frames. */
      fetchBtn.addEventListener("click", function () {
        if (!S.route) {
          setMsg(fetchStatus, "Get directions first, then load photos.", "error");
          return;
        }
        if (S.fetching) return;
        if (!S.sections.length) initSectionsForRoute();
        var samples = buildRouteSamples(S.route, currentSamplingSettings());
        invalidateFrames("");
        S.frames = samples.map(function (s) {
          var f = {
            lat: s.lat, lng: s.lng,
            panoLat: null, panoLng: null,
            heading: s.heading, finalHeading: s.heading,
            kind: s.kind, roadClass: s.roadClass || "local", turnIndex: s.turnIndex,
            turnLat: s.turnLat, turnLng: s.turnLng, turnDist: s.turnDist, turnOffsetM: (s.turnOffsetM != null ? s.turnOffsetM : null),
            dist: s.dist,
            status: "pending",
            panoId: null, date: "", copyright: "", filteredReason: null, blob: null, url: null,
            sectionIndex: -1, sectionLabel: null
          };
          return assignSectionToFrame(f);
        });
        // Full reload resets per-section overrides to the global sampling
        S.sections.forEach(function (sec) {
          var c = S.frames.filter(function (f) { return f.sectionIndex === sec.index && (f.kind === "route" || f.kind === "section"); }).length;
          sec.targetCount = Math.max(1, c || sec.targetCount || 1);
          sec.overridden = false;
        });
        drawDots();
        buildFilmstrip();
        S.fetching = true;
        S.cancelFetch = false;
        fetchBtn.disabled = true;
        $("cancelFetchBtn").hidden = false;
        fetchBar.hidden = false;
        fetchBar.firstElementChild.style.width = "0%";
        $("gifBtn").disabled = true;
        fetchFrames();
      });

      $("cancelFetchBtn").addEventListener("click", function () {
        S.cancelFetch = true;
        setMsg(fetchStatus, "Cancelling…", "info");
      });

      function kindLabel(f) {
        if (f.kind === "before-turn") return "Before turn";
        if (f.kind === "mid-turn") return "Mid turn";
        if (f.kind === "after-turn") return "After turn";
        if (f.kind === "section") return "Between turns";
        return "";
      }
      function isTurnFrame(f) {
        return !!(f.kind && f.kind !== "route" && f.kind !== "section");
      }
      function frameMetaLabel(f) {
        var cls = f.roadClass === "interstate" ? "INT" : "LOC";
        var hdg = headingLabel(f);
        return hdg ? cls + " · HDG " + hdg : cls;
      }
      function headingLabel(f) {
        var h = (f.finalHeading != null ? f.finalHeading : f.heading);
        if (h == null || isNaN(h)) return "";
        return Math.round(((h % 360) + 360) % 360) + "°";
      }
      function sectionEstimateText(sec) {
        var n = sec.targetCount || 1;
        var secs = n * currentDelaySec();
        return n + " frame" + (n === 1 ? "" : "s") + " · " + fmtGifLength(secs) + " · " + fmtGifSizeShort(n) + " est.";
      }
      function refreshSectionControls() {
        S.sections.forEach(function (sec) {
          var range = document.getElementById("sectionRange-" + sec.index);
          var val = document.getElementById("sectionVal-" + sec.index);
          var est = document.getElementById("sectionEst-" + sec.index);
          if (range && !sec.overridden) range.value = String(sec.targetCount);
          if (val) val.textContent = String(sec.targetCount);
          if (est) est.textContent = sectionEstimateText(sec);
          var countsEl = document.getElementById("sectionCounts-" + sec.index);
          if (countsEl) {
            var c = sectionCounts(sec.index);
            countsEl.textContent = c.total === 0
              ? "not loaded yet"
              : c.loaded + " loaded · " + c.filtered + " filtered · " + c.nocov + " no coverage · " + c.total + " total";
          }
        });
      }
      function createFrameFigure(f, i) {
        var isTurn = isTurnFrame(f);
        var showTag = isTurn || f.kind === "section";
        var fig = document.createElement("figure");
        fig.className = "frame" + (isTurn ? " turn-frame" : "");
        fig.style.margin = "0";
        fig.id = "frame-" + i;
        if (f.status === "ok" && f.url) {
          // loaded image
          var img = document.createElement("img");
          img.src = f.url;
          var hdg = headingLabel(f);
          img.alt = "Street View photo " + (i + 1) + " of " + S.frames.length + " along the route" +
            (showTag ? " (" + kindLabel(f).toLowerCase() + ")" : "") +
            ", " + (f.roadClass === "interstate" ? "interstate" : "local street") +
            (hdg ? ", heading " + hdg : "");
          img.loading = "lazy";
          fig.appendChild(img);
        } else {
          var slot = document.createElement("div");
          slot.className = "noimg";
          if (f.status === "filtered") slot.textContent = "non-road pano (filtered)";
          else if (f.status === "nocov") slot.textContent = "no coverage";
          else if (f.status === "error") slot.textContent = "load failed";
          else slot.textContent = "···";
          if (f.status === "filtered" || f.status === "nocov" || f.status === "error") fig.classList.add("miss");
          fig.appendChild(slot);
        }
        var cap = document.createElement("figcaption");
        var left = document.createElement("span");
        left.style.display = "inline-flex";
        left.style.alignItems = "center";
        left.style.gap = "5px";
        var num = document.createElement("span");
        num.textContent = "#" + (i + 1);
        left.appendChild(num);
        if (showTag) {
          var tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = kindLabel(f);
          left.appendChild(tag);
        }
        var mid = document.createElement("span");
        mid.className = "fhead";
        mid.title = "Road class (INT = interstate, LOC = local) and camera heading in degrees, snapped to the panorama";
        mid.textContent = frameMetaLabel(f);
        var when = document.createElement("span");
        when.className = "fdate";
        when.textContent = (f.status === "ok" ? (f.date || "") : "");
        cap.appendChild(left);
        cap.appendChild(mid);
        cap.appendChild(when);
        fig.appendChild(cap);
        return fig;
      }
      function buildFilmstrip() {
        var wrap = $("filmSections");
        if (!wrap) return;
        // preserve open state from DOM before rebuild
        S.sections.forEach(function (sec) {
          var det = document.getElementById("routeSection-" + sec.index);
          if (det) sec.open = !!det.open;
        });
        wrap.innerHTML = "";
        if (!S.sections.length && S.route) initSectionsForRoute();
        if (!S.sections.length) {
          $("filmCard").hidden = true;
          return;
        }
        S.sections.forEach(function (sec) {
          var details = document.createElement("details");
          details.className = "route-section";
          details.id = "routeSection-" + sec.index;
          if (sec.open) details.open = true;
          details.addEventListener("toggle", function () { sec.open = !!details.open; });
          var summary = document.createElement("summary");
          var title = document.createElement("span");
          title.className = "section-title";
          title.textContent = sec.label;
          var counts = document.createElement("span");
          counts.className = "section-counts";
          counts.id = "sectionCounts-" + sec.index;
          var c0 = sectionCounts(sec.index);
          counts.textContent = c0.total === 0 ? "not loaded yet" : c0.loaded + " loaded · " + c0.filtered + " filtered · " + c0.nocov + " no coverage · " + c0.total + " total";
          summary.appendChild(title);
          summary.appendChild(counts);
          details.appendChild(summary);

          var body = document.createElement("div");
          body.className = "section-body";

          var controls = document.createElement("div");
          controls.className = "section-controls";
          var lab = document.createElement("label");
          lab.htmlFor = "sectionRange-" + sec.index;
          lab.textContent = "Frames in this section";
          controls.appendChild(lab);
          var sliderRow = document.createElement("div");
          sliderRow.className = "slider-row";
          var range = document.createElement("input");
          range.type = "range";
          range.min = "1";
          range.max = "100";
          range.step = "1";
          range.value = String(sec.targetCount || 1);
          range.id = "sectionRange-" + sec.index;
          range.setAttribute("aria-label", "Number of frames for " + sec.label);
          var val = document.createElement("span");
          val.className = "slider-val";
          val.id = "sectionVal-" + sec.index;
          val.textContent = String(sec.targetCount || 1);
          sliderRow.appendChild(range);
          sliderRow.appendChild(val);
          controls.appendChild(sliderRow);
          var est = document.createElement("span");
          est.className = "section-estimate";
          est.id = "sectionEst-" + sec.index;
          est.textContent = sectionEstimateText(sec);
          controls.appendChild(est);
          var refetchBtn = document.createElement("button");
          refetchBtn.type = "button";
          refetchBtn.className = "btn btn-ghost section-refetch";
          refetchBtn.id = "sectionRefetch-" + sec.index;
          refetchBtn.textContent = S.sectionFetching[sec.index] ? "Re-fetching…" : "Re-fetch section";
          refetchBtn.disabled = !!S.sectionFetching[sec.index] || S.fetching;
          controls.appendChild(refetchBtn);
          var status = document.createElement("span");
          status.className = "section-status";
          status.id = "sectionStatus-" + sec.index;
          status.setAttribute("aria-live", "polite");
          controls.appendChild(status);
          body.appendChild(controls);

          range.addEventListener("input", function () {
            var v = Math.max(1, Math.min(100, parseInt(range.value, 10) || 1));
            sec.targetCount = v;
            sec.overridden = true;
            val.textContent = String(v);
            est.textContent = sectionEstimateText(sec);
            updateEstimateDisplay();
          });
          refetchBtn.addEventListener("click", function () { refetchSection(sec.index); });

          var framesInSection = [];
          S.frames.forEach(function (f, i) { if (f.sectionIndex === sec.index) framesInSection.push({ f: f, i: i }); });
          if (!framesInSection.length) {
            var empty = document.createElement("p");
            empty.className = "section-empty";
            empty.textContent = "No photos loaded for this stretch yet — set the frame count and choose Re-fetch section, or load all photos in step 4.";
            body.appendChild(empty);
          } else {
            var grid = document.createElement("div");
            grid.className = "film-grid";
            framesInSection.forEach(function (item) { grid.appendChild(createFrameFigure(item.f, item.i)); });
            body.appendChild(grid);
          }
          details.appendChild(body);
          wrap.appendChild(details);
        });
        $("filmCard").hidden = false;
        var dbgBtn2 = $("copyDebugBtn");
        if (dbgBtn2) dbgBtn2.disabled = S.frames.length === 0;
        updateFilmMeta();
        updateEstimateDisplay();
      }
      function refreshSectionCountsUI() {
        S.sections.forEach(function (sec) {
          var el = document.getElementById("sectionCounts-" + sec.index);
          if (!el) return;
          var c = sectionCounts(sec.index);
          el.textContent = c.total === 0 ? "not loaded yet" : c.loaded + " loaded · " + c.filtered + " filtered · " + c.nocov + " no coverage · " + c.total + " total";
        });
      }
      function refetchSection(sectionIdx) {
        if (!S.route) return;
        if (S.fetching || S.sectionFetching[sectionIdx]) return;
        var sec = S.sections[sectionIdx];
        if (!sec) return;
        var target = Math.max(1, Math.min(100, sec.targetCount || 1));
        sec.open = true;
        var statusEl = document.getElementById("sectionStatus-" + sectionIdx);
        var btn = document.getElementById("sectionRefetch-" + sectionIdx);
        function setSectionStatus(text, kind) {
          if (statusEl) { statusEl.textContent = text || ""; statusEl.className = "section-status" + (kind ? " " + kind : ""); }
        }
        // Build new sample points evenly inside the stretch
        var geom = getRouteGeom(S.route);
        var path = S.route.path, cum = geom.cum, total = geom.total;
        var len = Math.max(0, sec.endDist - sec.startDist);
        var newFrames = [];
        for (var k = 0; k < target; k++) {
          var d = len === 0 ? sec.startDist : sec.startDist + (k + 0.5) * (len / target);
          d = Math.max(0, Math.min(total, d));
          var p = pointAtDist(path, cum, total, d);
          var h = routeHeading(path, cum, total, d, S.route.turns || []);
          newFrames.push({
            lat: p.lat, lng: p.lng,
            panoLat: null, panoLng: null,
            heading: h, finalHeading: h,
            kind: "route", roadClass: sec.roadClass, turnIndex: -1,
            turnLat: null, turnLng: null, turnDist: null, turnOffsetM: null,
            dist: d,
            status: "pending",
            panoId: null, date: "", copyright: "", filteredReason: null, blob: null, url: null,
            sectionIndex: sectionIdx, sectionLabel: sec.label
          });
        }
        // Remove only this section's route/section frames; turn frames are preserved
        var kept = [];
        S.frames.forEach(function (f) {
          var isSectionRouteFrame = f.sectionIndex === sectionIdx && (f.kind === "route" || f.kind === "section");
          if (isSectionRouteFrame) {
            if (f.url) URL.revokeObjectURL(f.url);
            return;
          }
          kept.push(f);
        });
        var merged = kept.concat(newFrames);
        merged.sort(function (a, b) { return (a.dist || 0) - (b.dist || 0); });
        // Re-assign section indices by dist for any frame whose section may have shifted (keeps labels fresh), but preserve turn frames' section for display
        S.frames = merged.map(function (f) {
          // For newly created frames keep their section; for others recompute if it is a route frame, else keep existing grouping by dist
          if (newFrames.indexOf(f) === -1) {
            var idx = sectionIndexForDist(f.dist || 0);
            // Only reassign non-turn frames strictly; turn frames follow dist grouping for display
            f.sectionIndex = idx;
            f.sectionLabel = (idx >= 0 && S.sections[idx]) ? S.sections[idx].label : f.sectionLabel;
          }
          return f;
        });
        S.sectionFetching[sectionIdx] = true;
        if (btn) { btn.disabled = true; btn.textContent = "Re-fetching…"; }
        setSectionStatus("Loading " + target + " frame" + (target === 1 ? "" : "s") + " for this section…", "");
        buildFilmstrip();
        // buildFilmstrip resets button via S.sectionFetching — re-acquire
        btn = document.getElementById("sectionRefetch-" + sectionIdx);
        statusEl = document.getElementById("sectionStatus-" + sectionIdx);
        if (btn) { btn.disabled = true; btn.textContent = "Re-fetching…"; }
        if (statusEl) statusEl.textContent = "Loading " + target + " frame" + (target === 1 ? "" : "s") + " for this section…";
        drawDots();
        // Fetch only the new frames
        var indices = [];
        S.frames.forEach(function (f, i) { if (newFrames.indexOf(f) !== -1) indices.push(i); });
        var done = 0, okC = 0;
        var CONC = 4, cursor = 0;
        function finishSection() {
          S.sectionFetching[sectionIdx] = false;
          var b2 = document.getElementById("sectionRefetch-" + sectionIdx);
          if (b2) { b2.disabled = false; b2.textContent = "Re-fetch section"; }
          var c = sectionCounts(sectionIdx);
          var s2 = document.getElementById("sectionStatus-" + sectionIdx);
          if (s2) {
            s2.textContent = c.loaded + " loaded · " + c.filtered + " filtered · " + c.nocov + " no coverage in this section.";
            s2.className = "section-status" + (c.loaded ? " ok" : "");
          }
          // Rebuild figures for this section with loaded images
          buildFilmstrip();
          var okTotal = S.frames.filter(function (f) { return f.status === "ok"; }).length;
          $("gifBtn").disabled = okTotal === 0;
          if (okTotal > 0) setMsg($("gifStatus"), okTotal + " frames ready.", "info");
          setMsg(fetchStatus, "Section " + (sectionIdx + 1) + " re-fetched: " + c.loaded + " photo" + (c.loaded === 1 ? "" : "s") + " loaded in this stretch. Other sections were not re-downloaded.", c.loaded ? "ok" : "info");
          updateFilmMeta();
          updateEstimateDisplay();
        }
        function worker() {
          if (cursor >= indices.length) return Promise.resolve();
          var myIdx = indices[cursor++];
          return fetchOne(myIdx).then(function () {
            done++;
            if (S.frames[myIdx] && S.frames[myIdx].status === "ok") okC++;
            paintDot(myIdx);
            refreshSectionCountsUI();
            updateFilmMeta();
            var s3 = document.getElementById("sectionStatus-" + sectionIdx);
            if (s3) s3.textContent = "Loading… " + done + " / " + indices.length;
            // update the single figure in place if possible
            var fig = $("frame-" + myIdx);
            if (fig) {
              var fresh = createFrameFigure(S.frames[myIdx], myIdx);
              fig.replaceWith(fresh);
            }
            return worker();
          });
        }
        if (!indices.length) { finishSection(); return; }
        var lanes = [];
        for (var w = 0; w < Math.min(CONC, indices.length); w++) lanes.push(worker());
        Promise.all(lanes).then(finishSection).catch(finishSection);
      }

      function updateFrameHeadingLabel(i) {
        var fig = $("frame-" + i);
        if (!fig) return;
        var el = fig.querySelector(".fhead");
        var f = S.frames[i];
        if (el && f) {
          el.textContent = frameMetaLabel(f);
        }
      }

      function updateFilmMeta(extra) {
        var ok = 0, miss = 0, filtered = 0, turnOk = 0, sectionCount = 0;
        S.frames.forEach(function (f) {
          if (f.kind === "section") sectionCount++;
          if (f.status === "ok") { ok++; if (isTurnFrame(f)) turnOk++; }
          else if (f.status === "filtered") filtered++;
          else if (f.status === "nocov" || f.status === "error") miss++;
        });
        var turnTotal = S.frames.filter(function (f) { return isTurnFrame(f); }).length;
        var sectionTotal = S.sections ? S.sections.length : 0;
        $("filmMeta").textContent =
          ok + " photo" + (ok === 1 ? "" : "s") + " loaded" +
          (turnTotal ? " · " + turnOk + "/" + turnTotal + " turn photos" : "") +
          (sectionCount ? " · " + sectionCount + " between-turns" : "") +
          (filtered ? " · " + filtered + " filtered as non-road" : "") +
          (miss ? " · " + miss + " without coverage" : "") +
          " of " + S.frames.length + " samples" +
          (sectionTotal ? " across " + sectionTotal + " section" + (sectionTotal === 1 ? "" : "s") : "") +
          ", in route order. GIF order is global route order regardless of grouping. INT = interstate, LOC = local; HDG is the camera heading in degrees." +
          (extra ? " " + extra : "");
        refreshSectionCountsUI();
      }

      /* Frame debug dump — metadata only, NEVER the API key (or any URL
         containing it). Built from S.frames/S.route primitives so the key
         and blob URLs cannot leak in by accident. */
      function numOrNull(v) {
        return (typeof v === "number" && isFinite(v)) ? v : null;
      }
      function buildFrameDebugDump() {
        var settings = currentSamplingSettings();
        var originLabel = ($("originInput").value || "").trim() || null;
        var destLabel = ($("destInput").value || "").trim() || null;
        var route = S.route || null;
        var segMi = route ? segmentMiles(route) : { interstate: 0, local: 0 };
        var frames = S.frames.map(function (f, i) {
          return {
            index: i,
            sectionIndex: (f.sectionIndex != null ? f.sectionIndex : null),
            sectionLabel: f.sectionLabel || null,
            section: (f.sectionIndex != null && S.sections && S.sections[f.sectionIndex])
              ? { index: S.sections[f.sectionIndex].index, label: S.sections[f.sectionIndex].label, roadClass: S.sections[f.sectionIndex].roadClass, startDistM: numOrNull(S.sections[f.sectionIndex].startDist), endDistM: numOrNull(S.sections[f.sectionIndex].endDist) }
              : null,
            kind: f.kind || "route",
            roadClass: f.roadClass || "local",
            turnIndex: (f.turnIndex != null ? f.turnIndex : null),
            turnOffsetM: (f.turnOffsetM != null ? numOrNull(f.turnOffsetM) : null),
            requested: { lat: numOrNull(f.lat), lng: numOrNull(f.lng) },
            distAlongRouteM: numOrNull(f.dist),
            requestedHeadingDeg: numOrNull(f.heading),
            finalHeadingDeg: numOrNull(f.finalHeading),
            status: f.status || null,
            filteredReason: f.filteredReason || null,
            panoId: f.panoId || null,
            panoLocation: (f.panoLat != null && f.panoLng != null)
              ? { lat: numOrNull(f.panoLat), lng: numOrNull(f.panoLng) } : null,
            panoDate: f.date || null,
            copyright: f.copyright || null,
            streetViewSource: "outdoor"
          };
        });
        return {
          route: {
            origin: originLabel,
            destination: destLabel,
            description: route ? (route.description || null) : null,
            distanceMeters: route ? numOrNull(route.distanceMeters) : null,
            distanceMiles: route ? Number((route.distanceMeters / 1609.344).toFixed(4)) : null,
            interstateMiles: route ? Number(segMi.interstate.toFixed(4)) : null,
            localMiles: route ? Number(segMi.local.toFixed(4)) : null,
            segments: route && route.segments ? route.segments.map(function (s) {
              return { startDistM: numOrNull(s.startDist), endDistM: numOrNull(s.endDist), roadClass: s.roadClass };
            }) : [],
            sections: S.sections ? S.sections.map(function (s) {
              return { index: s.index, label: s.label, roadClass: s.roadClass, startDistM: numOrNull(s.startDist), endDistM: numOrNull(s.endDist), miles: Number((s.miles || 0).toFixed(4)), from: s.fromLabel, to: s.toLabel, targetFrames: s.targetCount };
            }) : [],
            durationSeconds: route ? numOrNull(route.durationSeconds) : null,
            interstatePhotosPerMile: settings.interstatePpm,
            localPhotosPerMile: settings.localPpm,
            photosPerTurn: settings.perTurn,
            totalFrames: S.frames.length,
            turnsCount: route && route.turns ? route.turns.length : frames.filter(function (x) { return x.kind === "before-turn" || x.kind === "mid-turn" || x.kind === "after-turn"; }).length
          },
          frames: frames
        };
      }

      function fallbackCopyText(text) {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
      }

      var copyDebugBtnEl = $("copyDebugBtn");
      if (copyDebugBtnEl) {
        copyDebugBtnEl.addEventListener("click", function () {
          var statusEl = $("copyDebugStatus");
          function confirmCopied() {
            if (!statusEl) return;
            statusEl.textContent = "Copied";
            statusEl.className = "copy-status ok";
            setTimeout(function () {
              if (statusEl.textContent === "Copied") {
                statusEl.textContent = "";
                statusEl.className = "copy-status";
              }
            }, 2600);
          }
          function confirmFailed() {
            if (!statusEl) return;
            statusEl.textContent = "Copy failed — clipboard unavailable in this browser.";
            statusEl.className = "copy-status error";
          }
          if (!S.frames.length) {
            if (statusEl) {
              statusEl.textContent = "Load photos first.";
              statusEl.className = "copy-status";
            }
            return;
          }
          var text = JSON.stringify(buildFrameDebugDump(), null, 2);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(confirmCopied).catch(function () {
              if (fallbackCopyText(text)) confirmCopied(); else confirmFailed();
            });
          } else if (fallbackCopyText(text)) {
            confirmCopied();
          } else {
            confirmFailed();
          }
        });
      }

      function fetchFrames() {
        var total = S.frames.length, done = 0, okCount = 0, idx = 0;
        var CONCURRENCY = 4;

        function finish() {
          S.fetching = false;
          fetchBtn.disabled = false;
          $("cancelFetchBtn").hidden = true;
          fetchBar.hidden = true;
          buildFilmstrip();
          updateFilmMeta();
          updateEstimateDisplay();
          var filteredCount = 0, missCount = 0;
          S.frames.forEach(function (f) {
            if (f.status === "filtered") filteredCount++;
            else if (f.status === "nocov" || f.status === "error") missCount++;
          });
          var tail = filteredCount ?
            " " + filteredCount + " frame" + (filteredCount === 1 ? " was" : "s were") +
            " filtered as non-road (nearest panorama was user-contributed, not a Google road view):" +
            " a frame shows as filtered rather than using that photo, since Street View returns only the nearest panorama." : "";
          if (S.cancelFetch) {
            setMsg(fetchStatus, "Loading cancelled. " + okCount + " photo" + (okCount === 1 ? "" : "s") + " kept." + tail, "info");
          } else if (okCount === 0) {
            setMsg(fetchStatus,
              "No usable Street View photos along this route (" + filteredCount + " filtered as non-road, " + missCount + " with no coverage). The roads may not have official coverage, or the Street View Static API is not enabled on this key.",
              "error");
          } else {
            setMsg(fetchStatus,
              okCount + " photo" + (okCount === 1 ? "" : "s") + " ready" +
              (filteredCount ? ", " + filteredCount + " filtered as non-road" : "") +
              (missCount ? ", " + missCount + " no coverage" : "") +
              " of " + total + ". Generate the GIF in step 5 — or adjust the sliders and reload for more/fewer frames." + tail,
              "ok");
          }
          $("gifBtn").disabled = okCount === 0;
          $("gifBtn").textContent = "Generate GIF";
          if (okCount > 0) setMsg($("gifStatus"), okCount + " frames ready.", "info");
        }

        function worker() {
          if (S.cancelFetch || idx >= total) return Promise.resolve();
          var i = idx++;
          return fetchOne(i).then(function () {
            done++;
            if (S.frames[i].status === "ok") okCount++;
            fetchBar.firstElementChild.style.width = Math.round(done / total * 100) + "%";
            setMsg(fetchStatus, "Loading photos… " + done + " / " + total, "info");
            paintDot(i);
            updateFilmMeta();
            return worker();
          });
        }

        var queue = [];
        var lanes = Math.min(CONCURRENCY, total);
        for (var w = 0; w < lanes; w++) queue.push(worker());
        if (!queue.length) { finish(); return; }
        Promise.all(queue).then(finish);
      }

      /* Recompute the heading from the SNAPPED panorama location.
         Street View snaps the requested point to the nearest panorama;
         facing from the requested point can be a few metres off. Facing
         from the actual pano toward the correct target keeps the camera
         looking down the road:
           - route photo: pano -> next point ahead on the route
           - before-turn: pano -> the turn point (incoming road only)
           - after-turn:  pano -> a point ahead on the outgoing leg
         If the pano is essentially on top of the target (<8 m), the
         precomputed corner-safe heading (f.heading) is more stable. */
      function computeFinalHeading(f, panoLoc) {
        if (!panoLoc || !S.route || !S.route.path || !S.route.path.length) return f.heading;
        var geom = getRouteGeom(S.route);
        var path = S.route.path, cum = geom.cum, total = geom.total;
        var target = null;
        if (f.kind === "before-turn" && f.turnLat != null && f.turnLng != null) {
          target = { lat: f.turnLat, lng: f.turnLng };
          if (haversine(panoLoc, target) > 8) return bearing(panoLoc, target);
          return f.heading; // incomingHeading, computed only from pre-turn points
        }
        if (f.kind === "mid-turn" && f.turnDist != null) {
          target = pointAtDist(path, cum, total, Math.min(total, f.turnDist + 30));
          if (haversine(panoLoc, target) > 8) return bearing(panoLoc, target);
          return f.heading; // midHeading, computed from the turn point toward the outgoing leg
        }
        if (f.kind === "after-turn" && f.turnDist != null) {
          // Face ahead on the outgoing leg from wherever this turn
          // photo sits (covers every positive per-turn offset, not
          // just the classic +45 m one).
          var aheadOfFrame = (f.dist != null ? f.dist : f.turnDist) + 55;
          target = pointAtDist(path, cum, total, Math.min(total, Math.max(f.turnDist + 70, aheadOfFrame)));
          if (haversine(panoLoc, target) > 8) return bearing(panoLoc, target);
          return f.heading; // outgoingHeading, computed only from post-turn points
        }
        // base / route photo
        if (f.dist != null && f.dist >= total - 4) {
          var behind = pointAtDist(path, cum, total, Math.max(0, total - 70));
          if (haversine(behind, panoLoc) > 8) return bearing(behind, panoLoc);
          return f.heading;
        }
        var aheadDist = f.dist != null ? Math.min(total, f.dist + 70) : total;
        target = pointAtDist(path, cum, total, aheadDist);
        if (haversine(panoLoc, target) > 8) return bearing(panoLoc, target);
        return f.heading;
      }

      function fetchOne(i) {
        var f = S.frames[i];
        // source=outdoor excludes indoor / business-interior panoramas,
        // which otherwise get snapped to when the route passes a place.
        var metaUrl = "https://maps.googleapis.com/maps/api/streetview/metadata" +
          "?location=" + f.lat.toFixed(6) + "," + f.lng.toFixed(6) +
          "&source=outdoor" +
          "&key=" + encodeURIComponent(S.key);
        return fetch(metaUrl).then(function (r) { return r.json(); }).then(function (meta) {
          if (!meta || meta.status !== "OK" || !meta.pano_id) {
            if (meta && meta.status === "REQUEST_DENIED") {
              throw new Error("denied");
            }
            f.status = "nocov";
            markFrameMissing(i, "no coverage");
            return null;
          }
          f.panoId = meta.pano_id;
          f.date = meta.date || "";
          f.copyright = meta.copyright || "";
          /* Non-road filter. source=outdoor excludes indoor panoramas,
             but Street View still snaps to the nearest OUTDOOR pano —
             including user-contributed Photospheres (sidewalks, parks,
             subway platforms, building interiors shot from outside),
             which are not road frames. Official Google car panos carry
             copyright "© Google…" and short opaque pano_ids; user
             contributions carry the contributor's name in the copyright
             and pano_ids starting with "CAo". Reject those before the
             (billed) image download: when the only nearby pano is
             user-contributed, this frame stays filtered rather than
             showing a non-road photo. */
          if (!/^© Google/.test(f.copyright) || String(f.panoId).indexOf("CAo") === 0) {
            f.status = "filtered";
            f.filteredReason = "user-contributed pano";
            markFrameMissing(i, "non-road pano (filtered)");
            return null;
          }
          var panoLoc = null;
          if (meta.location && typeof meta.location.lat === "number" && typeof meta.location.lng === "number") {
            panoLoc = { lat: meta.location.lat, lng: meta.location.lng };
            f.panoLat = panoLoc.lat;
            f.panoLng = panoLoc.lng;
          }
          // Snap-aware final heading — this is what we actually request.
          f.finalHeading = computeFinalHeading(f, panoLoc);
          updateFrameHeadingLabel(i);
          var imgUrl = "https://maps.googleapis.com/maps/api/streetview" +
            "?size=640x360&pano=" + encodeURIComponent(meta.pano_id) +
            "&heading=" + Number(f.finalHeading).toFixed(1) +
            "&pitch=0&fov=90&return_error_code=true&source=outdoor" +
            "&key=" + encodeURIComponent(S.key);
          return fetch(imgUrl).then(function (r) {
            if (!r.ok) throw new Error("http " + r.status);
            return r.blob();
          }).then(function (blob) {
            if (!blob || blob.type.indexOf("image") !== 0) throw new Error("not an image");
            f.blob = blob;
            f.url = URL.createObjectURL(blob);
            f.status = "ok";
            markFrameLoaded(i);
          });
        }).catch(function (err) {
          if (err && err.message === "denied") {
            f.status = "error";
            markFrameMissing(i, "API denied");
            setMsg(fetchStatus,
              "Street View said REQUEST_DENIED — enable the Street View Static API on this key's project and check billing/referrer restrictions.",
              "error");
          } else if (f.status === "pending") {
            f.status = "error";
            markFrameMissing(i, "load failed");
          }
        });
      }

      function markFrameLoaded(i) {
        var fig = $("frame-" + i);
        if (!fig) return;
        var f = S.frames[i];
        var isTurn = isTurnFrame(f);
        var showTag = isTurn || f.kind === "section";
        fig.className = "frame" + (isTurn ? " turn-frame" : "");
        fig.innerHTML = "";
        var img = document.createElement("img");
        img.src = f.url;
        var hdg = headingLabel(f);
        img.alt = "Street View photo " + (i + 1) + " of " + S.frames.length + " along the route" +
          (showTag ? " (" + kindLabel(f).toLowerCase() + ")" : "") +
          ", " + (f.roadClass === "interstate" ? "interstate" : "local street") +
          (hdg ? ", heading " + hdg : "");
        img.loading = "lazy";
        fig.appendChild(img);
        var cap = document.createElement("figcaption");
        var left = document.createElement("span");
        left.style.display = "inline-flex";
        left.style.alignItems = "center";
        left.style.gap = "5px";
        var num = document.createElement("span");
        num.textContent = "#" + (i + 1);
        left.appendChild(num);
        if (showTag) {
          var tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = kindLabel(f);
          left.appendChild(tag);
        }
        var mid = document.createElement("span");
        mid.className = "fhead";
        mid.title = "Road class (INT = interstate, LOC = local) and camera heading, snapped to the panorama";
        mid.textContent = frameMetaLabel(f);
        var when = document.createElement("span");
        when.textContent = f.date || "";
        cap.appendChild(left);
        cap.appendChild(mid);
        cap.appendChild(when);
        fig.appendChild(cap);
      }

      function markFrameMissing(i, label) {
        var fig = $("frame-" + i);
        if (!fig) return;
        fig.classList.add("miss");
        var slot = fig.querySelector(".noimg");
        if (slot) slot.textContent = label;
      }

      /* ---------------- Step 5: GIF encoding (gif.js) ---------------- */

      var gifBtn = $("gifBtn"), gifStatus = $("gifStatus"), gifBar = $("gifBar");
      var GIF_LIB = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.min.js";
      var GIF_WORKER = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";

      function ensureGifLib() {
        if (window.GIF && S.workerScriptUrl) return Promise.resolve();
        var libReady = window.GIF ? Promise.resolve() : loadScript(GIF_LIB);
        return libReady.then(function () {
          if (S.workerScriptUrl) return null;
          // Workers must be same-origin: fetch the worker script (the CDN
          // sends CORS headers) and re-serve it from a blob URL.
          return fetch(GIF_WORKER).then(function (r) {
            if (!r.ok) throw new Error("worker fetch " + r.status);
            return r.blob();
          }).then(function (blob) {
            S.workerScriptUrl = URL.createObjectURL(blob);
          });
        });
      }

      gifBtn.addEventListener("click", function () {
        var okFrames = S.frames.filter(function (f) { return f.status === "ok" && f.blob; });
        if (!okFrames.length) {
          setMsg(gifStatus, "Load Street View photos first.", "error");
          return;
        }
        if (S.generating) return;
        S.generating = true;
        gifBtn.disabled = true;
        gifBtn.textContent = "Encoding…";
        gifBar.hidden = false;
        gifBar.firstElementChild.style.width = "0%";
        setMsg(gifStatus, "Loading the GIF encoder…", "info");

        ensureGifLib().then(function () {
          setMsg(gifStatus, "Preparing frames…", "info");
          return buildGif(okFrames);
        }).then(function (blob) {
          if (S.gifUrl) URL.revokeObjectURL(S.gifUrl);
          S.gifUrl = URL.createObjectURL(blob);
          $("gifPreview").src = S.gifUrl;
          var dl = $("downloadBtn");
          dl.href = S.gifUrl;
          dl.setAttribute("download", "route.gif");
          var meta = okFrames.length + " frames · 640×360 · " +
                     (blob.size / 1048576).toFixed(2) + " MB · delay " +
                     ($("delaySelect").value / 1000) + "s per frame";
          $("gifMeta").textContent = meta;
          $("resultCard").hidden = false;
          $("resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
          setMsg(gifStatus, "Done — preview it below, then download route.gif.", "ok");
        }).catch(function (err) {
          setMsg(gifStatus,
            "GIF encoding failed (" + ((err && err.message) || err) + "). Check your connection and try again.",
            "error");
        }).then(function () {
          S.generating = false;
          gifBtn.disabled = false;
          gifBtn.textContent = "Regenerate GIF";
          gifBar.hidden = true;
        });
      });

      function buildGif(okFrames) {
        return new Promise(function (resolve, reject) {
          var W = 640, H = 360;
          var canvas = document.createElement("canvas");
          canvas.width = W; canvas.height = H;
          var ctx = canvas.getContext("2d");
          var delay = parseInt($("delaySelect").value, 10);
          var gif;
          try {
            gif = new window.GIF({
              workers: Math.min(4, okFrames.length),
              quality: 10,
              width: W,
              height: H,
              workerScript: S.workerScriptUrl,
              repeat: 0
            });
          } catch (e) { reject(e); return; }

          gif.on("progress", function (p) {
            gifBar.firstElementChild.style.width = Math.round(p * 100) + "%";
            setMsg(gifStatus, "Encoding GIF… " + Math.round(p * 100) + "%", "info");
          });
          gif.on("finished", function (blob) { resolve(blob); });

          // Add frames one by one so decoding stays sequential and ordered.
          var chain = Promise.resolve();
          okFrames.forEach(function (f) {
            chain = chain.then(function () {
              return loadBitmap(f.blob).then(function (bmp) {
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, W, H);
                ctx.drawImage(bmp, 0, 0, W, H);
                if (bmp.close) bmp.close();
                gif.addFrame(canvas, { copy: true, delay: delay });
              });
            });
          });
          chain.then(function () {
            setMsg(gifStatus, "Encoding GIF… 0%", "info");
            gif.render();
          }).catch(reject);
        });
      }

      function loadBitmap(blob) {
        if (window.createImageBitmap) {
          return createImageBitmap(blob).catch(function () { return loadViaImage(blob); });
        }
        return loadViaImage(blob);
      }

      function loadViaImage(blob) {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("frame decode failed")); };
          img.src = url;
        });
      }
