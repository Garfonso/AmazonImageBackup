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
const fs = require("fs");

//use someone elses client secret, because amazon won't give out new secrects, currently. :-(
const refreshProxyUrl = "https://drivesink.appspot.com/refresh";
const debugging = true;
const accessTokenPath = "./auth_access.json";

function debug(...msgs) {
    if (debugging) {
        console.log(...msgs);
    }
}

const readFilePromise = NodePromise.denodeify(fs.readFile);
const writeFilePromise = NodePromise.denodeify(fs.writeFile);
function requestPromise(options, postData, decode) {
    let promise = new NodePromise(function resolver(resolve, reject) {
        //debug("Sending request", options);
        let req = https.request(options, function callback(res) {
            let data = "";
            res.setEncoding("utf8");
            //debug("Headers:", res.headers);
            res.on("data", function (chunk) { data += chunk; });
            res.on("end", function () {
                //debug("Body: ", data);
                if (res.statusCode === 200) {
                    if (decode) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve(data);
                    }
                } else {
                    reject({msg: "Status code not 200: " + res.statusCode, data: data});
                }
            });
        });
        req.on("error", (err) => reject(err));
        req.end(postData);
    });

    return promise;
}

let authHeader;
function refreshToken(realRefresh) {
    let promise;
    if (!realRefresh) {
        promise = readFilePromise(accessTokenPath, "utf8");

        promise = promise.then(function gotToken(data) {
            let token = JSON.parse(data);
            debug("Got token from file");
            authHeader = "Bearer " + token.access_token;
            return token;
        }, function needToRefresh() {
            return refreshToken(true);
        });
    } else {
        let options = url.parse(refreshProxyUrl);
        options.method = "POST";
        let postData = querystring.stringify({refresh_token: auth.refresh_token});
        options.headers = {"Content-Length": Buffer.byteLength(postData)};

        promise = requestPromise(options, postData, true);

        promise = promise.then(function storeToken(token) {
            debug("Got token from refresh.");
            authHeader = "Bearer " + token.access_token;
            return writeFilePromise(accessTokenPath, JSON.stringify(token, null, 4), "utf8");
        });
    }

    return promise;
}

//first get access_token:
let promise = refreshToken();

/*promise = promise.then(function getRootNode() {
    let options = "";
    //requestPromise()
});*/

promise = promise.then(function allgood(result) {
    console.log("All good:", result);
}, function haderror(err) {
    console.log("Had error:", err);
});
