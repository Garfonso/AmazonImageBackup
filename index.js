/**
 * Created by achim on 31.07.2017.
 */
/*jslint node: true, es6: true, white: true */
/*jshint esversion: 6 */

"use strict";

const NodePromise = require("promise");
const https = require("https");
const url = require("url");
const querystring = require("querystring");
const fs = require("fs");
const crypto = require("crypto");

//parameter files:
const auth = require("./auth.json");
const config = require("./config.json");
if (config.targetPath.charAt(config.targetPath.length -1) !== "/") {
    config.targetPath += "/";
}
if (config.sourcePath.charAt(config.sourcePath.length -1) !== "/") {
    config.sourcePath += "/";
}

function debug(...msgs) {
    if (config.debugging) {
        console.log(...msgs);
    }
}

//denodifications:
const readFilePromise = NodePromise.denodeify(fs.readFile);
const writeFilePromise = NodePromise.denodeify(fs.writeFile);

let authHeader;
let refreshToken;
function requestPromise(options, postData, decode = true, retry = 0) {
    //add auth header.
    if (authHeader) {
        if (options.headers) {
            options.headers.Authorization = authHeader;
        } else {
            options.headers = {"Authorization": authHeader};
        }
    }
    let promise = new NodePromise(function resolver(resolve, reject) {
        //debug("Sending request", options);
        let req = https.request(options, function callback(res) {
            let data = "";
            res.setEncoding("utf8");
            //debug("Headers:", res.headers);
            res.on("data", function (chunk) { data += chunk; });
            res.on("end", function () {
                //debug("Body: ", data);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    if (decode) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve(data);
                    }
                } else if (res.statusCode === 401 && !retry) {
                    //need to refresh token.
                    let innerPromise = refreshToken(true);
                    innerPromise = innerPromise.then(function retryRequest() { //retry request.
                        return requestPromise(options, postData, decode, retry + 1);
                    });
                    resolve(innerPromise);
                } else {
                    reject({msg: "Status code not 200: " + res.statusCode, data: data});
                }
            });
        });
        req.on("error", (err) => reject(err));
        //debug("Writing:", postData);
        req.end(postData);
    });

    return promise;
}

//request from metadata server
function requestMetadata(path, jsonData, decode) {
    let options = url.parse(auth.metadataUrl + path);
    let postData;
    if (jsonData) {
        postData = JSON.stringify(jsonData);
        options.headers = {"Content-Length": Buffer.byteLength(postData)};
        options.method = "POST";
    }
    return requestPromise(options, postData, decode);
}
//request from content server
function requestContent(path, decode) {
    let options = url.parse(auth.contentUrl + path);
    return requestPromise(options, undefined, decode);
}
//handle all token stuff. will also update authorization header.
refreshToken = function(realRefresh) {
    let promise;
    authHeader = "";
    if (!realRefresh) {
        promise = readFilePromise(config.accessTokenPath, "utf8");

        promise = promise.then(function gotToken(data) {
            let token = JSON.parse(data);
            debug("Got token from file");
            authHeader = "Bearer " + token.access_token;
            return token;
        }, function needToRefresh() {
            debug("No token file. Get new token.");
            return refreshToken(true);
        });
    } else {
        let options = url.parse(config.refreshProxyUrl);
        options.method = "POST";
        let postData = querystring.stringify({refresh_token: auth.refresh_token});
        options.headers = {"Content-Length": Buffer.byteLength(postData)};

        promise = requestPromise(options, postData, true);

        promise = promise.then(function storeToken(token) {
            debug("Got token from refresh.");
            authHeader = "Bearer " + token.access_token;
            return writeFilePromise(config.accessTokenPath, JSON.stringify(token, null, 4), "utf8");
        });
    }
    return promise;
};

function nodesFromData(data) {
    if (data.data.length >= 0) {
        return data.data;
    }
    if (data.length >= 0) {
        return data;
    }
    throw "No nodes found in data.";
}

function createFolder(parentNode, name, fullPath) {
    debug("Creating " + name + " in " + (parentNode.name || "root"));
    let createUrl = "nodes?localId=" + fullPath;
    let jsonData = {
        name: name,
        kind: "FOLDER",
        parents: [parentNode.id]
    };
    return requestMetadata(createUrl, jsonData);
}

function listChildren(node, filter, children = [], nextToken = undefined) {
    let childrenUrl = "nodes/" + node.id + "/children";
    if (filter) {
        childrenUrl += "?filters=" + filter;
    }
    if (nextToken) {
        if (!filter) {
            childrenUrl += "?";
        } else {
            childrenUrl += "&";
        }
        childrenUrl += "startToken=" + nextToken;
    }
    let promise = requestMetadata(childrenUrl);

    promise = promise.then(function (res) {
        children = children.concat(nodesFromData(res));
        //debug("Got children: ", children);
        if (res.nextToken) {
            return listChildren(node, filter, children, res.nextToken);
        } else {
            return children;
        }
    });

    return promise;
}

//create md5 hash of a file for did change check:
function md5Hash(filename) {
    let promise = new NodePromise(function resolver(resolve, reject) {
        let md5sum = crypto.createHash("md5");
        const input = fs.createReadStream(filename);
        input.on("readable", function () { //using readable should increase throughput.
            const data = input.read();
            if (data) {
                md5sum.update(data);
            } else {
                const d = md5sum.digest("hex");
                resolve(d);
            }
        });
        input.on("error", function (err) {
            reject(err);
        });
    });
    return promise;
}

//first get access_token:
let promise = refreshToken();

promise = promise.then(function getRootNode() {
    return requestMetadata("nodes?filters=isRoot:true");
});

promise = promise.then(function hangleToTargetPath(data) {
    let root = nodesFromData(data)[0]; //can we have multiple root nodes?
    let currentNode = root;
    let currentPath = "/";
    let remainingPathItems = config.targetPath.split("/");
    remainingPathItems.pop();
    remainingPathItems.shift();

    function getDown() {
        //debug("remainingPath: ", remainingPathItems);
        if (remainingPathItems.length === 0) {
            if (currentPath !== config.targetPath) {
                throw currentPath + " != " + config.targetPath + ". Somehow path hangling went wrong.";
            }
            return currentNode;
        }
        let innerPromise = listChildren(currentNode, "kind:FOLDER");
        innerPromise = innerPromise.then(function (children) {
            let found = false;
            children.forEach(function (child) {
                if (child.name === remainingPathItems[0]) {
                    //debug("Found next part: ", child);
                    currentNode = child;
                    currentPath += child.name + "/";
                    found = true;
                }
            });
            if (!found) {
                return createFolder(currentNode, remainingPathItems[0], currentPath + remainingPathItems[0]);
            }
            remainingPathItems.shift();
            return getDown();
        });

        return innerPromise;
    }

    return getDown();
});


promise = promise.then(function allgood(result) {
    console.log("All good:", result);
}, function haderror(err) {
    console.log("Had error:", err);
});
