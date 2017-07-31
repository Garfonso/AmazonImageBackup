/**
 * Created by achim on 31.07.2017.
 */
/*jslint node: true, es6: true, white: true */
/*jshint esversion: 6 */

"use strict";

const NodePromise = require("promise");
const https = require("https");
const url = require("url");
const auth = require("./auth.json");
const querystring = require("querystring");

//use someone elses client secret, because amazon won't give out new secrects, currently. :-(
const refreshProxyUrl = "https://drivesink.appspot.com/refresh";

const debugging = true;

function debug(...msgs) {
    if (debugging) {
        console.log(...msgs);
    }
}

function refreshToken() {
    let promise = new NodePromise(function resolver(resolve, reject) {
        let options = url.parse(refreshProxyUrl);
        options.method = "POST";
        let postData = querystring.stringify({refresh_token: auth.refresh_token});
        options.headers = { "Content-Length": Buffer.byteLength(postData)};

        debug("Sending request", options);
        let req = https.request(options, function callback(res) {
            let data = "";
            res.setEncoding("utf8");
            debug("Headers:", res.headers);
            res.on("data", function (chunk) { data += chunk; });
            res.on("end", function () {
                debug("Body: ", data);
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {

                    reject("Status code not 200: " + res.statusCode);
                }
            });
        });
        req.on("error", (err) => reject(err));
        req.end(postData);
    });

    return promise;
}

let promise = refreshToken();

promise = promise.then(function allgood(result) {
    console.log("All good:", result);
}, function haderror(err) {
    console.log("Had error:", err);
});
