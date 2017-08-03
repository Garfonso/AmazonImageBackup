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
function requestPromise(options, postData, decode = true, overwriteOptions = false, retry = 0) {
    //add auth header.
    if (authHeader) {
        if (options.headers) {
            options.headers.Authorization = authHeader;
        } else {
            options.headers = {"Authorization": authHeader};
        }
    }
    if (overwriteOptions) {
        options.method = overwriteOptions.method || options.method;
        if (overwriteOptions.headers) {
            Object.keys(overwriteOptions.headers).forEach((key) => options.headers[key] = overwriteOptions.headers[key]);
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
                        return requestPromise(options, postData, decode, overwriteOptions, retry + 1);
                    });
                    resolve(innerPromise);
                } else {
                    reject({msg: "Status code not 200: " + res.statusCode, data: data});
                }
            });
        });
        req.on("error", (err) => reject(err));
        //debug("Writing:", postData);
        if (overwriteOptions && overwriteOptions.filestream) {
            req.write(postData, "utf8");
            //debug("Writing\n" + postData);
            overwriteOptions.filestream.on("readable", function () {
                let data = overwriteOptions.filestream.read();
                if (data) {
                    //debug("...");
                    stats.bytesUploaded += data.byteLength;
                    req.write(data, "binary");
                } else {
                    //debug(overwriteOptions.footerData);
                    req.end(overwriteOptions.footerData, "utf8");
                }
            });
        } else if (overwriteOptions && overwriteOptions.buffer) {
            req.write(postData, "utf8");
            req.write(overwriteOptions.buffer, "binary");
            req.end(overwriteOptions.footerData, "utf8");
        } else {
            req.end(postData);
        }
    });

    return promise;
}

//request from metadata server
function requestMetadata(path, jsonData, decode, overwriteOptions) {
    let options = url.parse(auth.metadataUrl + path);
    let postData;
    if (jsonData) {
        postData = JSON.stringify(jsonData);
        options.headers = {"Content-Length": Buffer.byteLength(postData)};
        options.method = "POST";
    }
    return requestPromise(options, postData, decode, overwriteOptions);
}
//request from content server
function requestContent(path, data, decode, overwriteOptions) {
    let options = url.parse(auth.contentUrl + path);
    options.method = "POST";
    return requestPromise(options, data, decode, overwriteOptions);
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

function findTypeFromName(name) {
    let ext = path.extname(name).toLocaleLowerCase();
    switch (ext) {
        case ".cod":
            return "cis-cod";
        case ".ras":
            return "cmu-raster";
        case ".bmp":
        case ".bm":
            return "bmp";
        case ".fif":
            return "fif";
        case ".gif":
            return "gif";
        case ".ief":
            return "ief";
        case ".jpeg":
        case ".jpg":
        case ".jpe":
            return "jpeg";
        case ".png":
            return "png";
        case ".tif":
        case ".tiff":
            return "tiff";
        case ".mcf":
            return "vasa";
        case ".wbmp":
            return "vnd.wap.wbmp";
        case ".fh4":
        case ".fh5":
        case ".fhc":
            return "x-freehand";
        case ".ico":
            return "x-icon";
        case ".pic":
            return "pict";
        case ".pnm":
            return "x-portable-anymap";
        case ".pbm":
            return "x-portable-bitmap";
        case ".pgm":
            return "x-portable-graymap";
        case ".ppm":
            return "x-portable-pixmap";
        case ".rgp":
            return "x-rgb";
        case ".xwd":
            return "x-windowdump";
        case ".xbm":
            return "x-xbitmap";
        case ".xpm":
            return "x-xpixmap";
        default:
            return "jpeg";
    }
}

//if it already exists, old file will be moved to trash.
function uploadFile(localChild) {
    //debug("Starting upload.");
    /*if (localChild.inCloud) {
        debug("Uploading newer version, will remove old file first.");
        promise = requestMetadata("trash/" + localChild.node.id, null, true, {method: "PUT"});
    } else {
        promise = NodePromise.resolve(true);
    }*/
    let data = "----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n";
    if (!localChild.inCloud) { //for new file add metadata:
        //debug("File not present, add metadata.");
        data += "Content-Disposition: form-data; name=\"metadata\"\r\n\r\n";
        let metadata = {
            name: localChild.name,
            kind: "FILE",
            parents: [localChild.parentNode.id]
        };
        data += JSON.stringify(metadata) + "\r\n----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n";
    }
    data += "Content-Disposition: form-data; name=\"content\"; ";
    data += "filename=\"" + localChild.name + "\"\r\n";
    data += "Content-Type: image/" + findTypeFromName(localChild.name) + "\r\n\r\n";

    let uploadPath = "nodes";
    let overwriteOptions = {
        method: "POST",
        filestream: fs.createReadStream(localChild.path),
        footerData: "\r\n----WebKitFormBoundaryE19zNvXGzXaLvS5C--\r\n"
    };
    if (localChild.inCloud) {
        uploadPath += "/" + localChild.node.id + "/content";
        overwriteOptions.method = "PUT";
    } else {
        uploadPath += "?suppress=deduplication";
    }

    overwriteOptions.headers = {
        "Content-Type": "multipart/form-data; boundary=--WebKitFormBoundaryE19zNvXGzXaLvS5C"
    };
    debug("Uploading " + localChild.name + " to " + localChild.parentNode.name);
    //debug("Url: ", uploadPath);
    //debug("Options:", overwriteOptions);
    stats.uploaded += 1;
    return requestContent(uploadPath, data, true, overwriteOptions);
}

//create md5 hash of a file for did change check:
function createMD5Hash(filename) {
    let promise = new NodePromise(function resolver(resolve, reject) {
        let md5sum = crypto.createHash("md5");
        const input = fs.createReadStream(filename);
        input.on("readable", function () { //using readable should increase throughput.
            const data = input.read();
            if (data) {
                md5sum.update(data);
            } else {
                const d = md5sum.digest("hex");
                if (config.writeHashes) {
                    writeFilePromise(filename + ".md5", d, "utf8").then(function () {
                        resolve(d);
                    });
                } else {
                    resolve(d);
                }
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
