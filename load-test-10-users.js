// full data:
// docker run -v ~/results/:/home/k6/results/ -i grafana/k6 -e DOMAIN_NAME="domains" run -o json=results/full.json.gz - <stress-test-k6.js
//
// using grafana:
// git clone https://github.com/luketn/docker-k6-grafana-influxdb.git
// cd docker-k6-grafana-influxdb
// docker-compose up -d influxdb grafana
// docker-compose run k6 -e DOMAIN_NAME="domains" run - <stress-test-k6.js
// see results in your web browser via http://localhost:3000/d/k6/k6-load-testing-results


import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";


var domainName; // domain name where our WooCommerce is set up
var pscheme = 'https';
var users = 10;  // how many users visits our website simultaneously
var minPause = 2; // a random pause between http requests (in seconds)
var maxPause = 5;
var phaseDuration = 10;
var rampDuration;

// domain name is required
if (__ENV.DOMAIN_NAME) {
    domainName = __ENV.DOMAIN_NAME;
} else {
    throw new Error(`DOMAIN_NAME is undefined. Specify environment variable DOMAIN_NAME to load.`);
}

//Remove http or https from domain name if present
if (domainName.indexOf('http') > -1) {
    domainName = domainName.replace('http://', '');
    domainName = domainName.replace('https://', '');
}

// defaults can be overwritten via env variables
users = __ENV.USERS ? __ENV.USERS : users;
users = Math.floor(users);
phaseDuration = __ENV.PHASE_DURATION ? __ENV.PHASE_DURATION : phaseDuration;
phaseDuration = Math.floor(phaseDuration);
rampDuration = Math.floor(phaseDuration / 5) + 1;

// A custom metric to track failure rates
var failureRate = new Rate("check_failure_rate");

// Options
export let options = {
    scenarios: {
        common_case: {
            startTime: "0s",
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { target: users, duration: "1m" },
                { target: users, duration: `${phaseDuration}m` }
            ]
        },
    },

    thresholds: {
        // We want the 95th percentile of all HTTP request durations to be less than 2.5s
        "http_req_duration": ["p(95)<2500"],
        // Requests with the staticAsset tag should finish faster
        "http_req_duration{staticAsset:yes}": ["p(95)<1000"],
        // Thresholds based on the custom metric we defined and use to track application failures
        "check_failure_rate": [
            // Global failure rate should be less than 1%
            "rate<0.01",
            // Abort the test early if it climbs over 80%
            { threshold: "rate<=0.8", abortOnFail: true },
        ],
    },
};

export default function () {
    let response = http.get(`${pscheme}://${domainName}/index.php`);

    // check() returns false if any of the specified conditions fail
    let checkRes = check(response, {
        "http2 is used": (r) => r.proto === "HTTP/2.0",
        "status is 200": (r) => r.status === 200,
        "content is present": (r) => r.body.indexOf("cart") !== -1,
    });

    // We reverse the check() result since we want to count the failures
    failureRate.add(!checkRes);

    // Load static assets, all requests
    group("Static Assets", function () {
        // Execute multiple requests in parallel like a browser, to fetch static resources
        let resps = http.batch([
            ["GET", `${pscheme}://${domainName}/woocommerce-placeholder-324x324.png`, null, { tags: { staticAsset: "yes" } }],
            ["GET", `${pscheme}://${domainName}/header-cart.min.js`, null, { tags: { staticAsset: "yes" } }],
        ]);
        // Combine check() call with failure tracking
        failureRate.add(!check(resps, {
            "status is 200": (r) => r[0].status === 200 && r[1].status === 200,
            "reused connection": (r) => r[0].timings.connecting === 0,
        }));
    });

    sleep(Math.random() * (maxPause-minPause) + minPause); // Random sleep
}

export function handleSummary(data) {
    return {
//        "results/result.json": JSON.stringify(data),
        stdout: textSummary(data, { indent: " ", enableColors: true }),
    };
}