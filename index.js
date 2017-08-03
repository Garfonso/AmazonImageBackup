/**
 * Created by achim on 31.07.2017.
 */
/*jslint node: true, es6: true, white: true */
/*jshint esversion: 6 */

"use strict";

const NodePromise = require("promise");
const https = require("https");
const url = require("url");
const path = require("path");
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
if (config.silent) {
    config.debugging = false;
}

function debug(...msgs) {
    if (config.debugging) {
        console.log(...msgs);
    }
}

let stats = {
    uploaded: 0,
    foldersCreated: 0,
    skipped: 0,
    alreadyPresent: 0,
    updated: 0,
    bytesUploaded: 0,
    foldersProcessed: 0,
    filesProcessed: 0
};

//denodifications:
const readFilePromise = NodePromise.denodeify(fs.readFile);
const writeFilePromise = NodePromise.denodeify(fs.writeFile);
const readdirPromise = NodePromise.denodeify(fs.readdir);
const statPromise = NodePromise.denodeify(fs.stat);

/********************************************************************************************************
 Low level Reqeuests.
 ********************************************************************************************************/

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
            Object.keys(overwriteOptions.headers).forEach(function(key) { options.headers[key] = overwriteOptions.headers[key];});
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
                        if (overwriteOptions && overwriteOptions.manualRetry) {
                            //do this if a filestream is already closed (image upload) or similar.
                            throw "Need retry";
                        } else {
                            return requestPromise(options, postData, decode, overwriteOptions, retry + 1);
                        }
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

/********************************************************************************************************
 Authorization
 ********************************************************************************************************/

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

/********************************************************************************************************
 Node handling
 ********************************************************************************************************/

function nodesFromData(data) {
    if (data.data.length >= 0) {
        return data.data;
    }
    if (data.length >= 0) {
        return data;
    }
    throw "No nodes found in data.";
}

/********************************************************************************************************
 Folder creation and listing
 ********************************************************************************************************/

function createFolder(parentNode, name, fullPath) {
    debug("Creating " + name + " in " + (parentNode.name || "root"));
    let createUrl = "nodes?localId=" + fullPath;
    let jsonData = {
        name: name,
        kind: "FOLDER",
        parents: [parentNode.id]
    };
    stats.foldersCreated += 1;
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

/********************************************************************************************************
 Upload file
 ********************************************************************************************************/

function findTypeFromName(name) {
    let ext = path.extname(name).toLocaleLowerCase();
    let mime = config.extensionsWithMime[ext];
    if (!mime) {
        return "image/jpeg";
    }
    return mime;
}

//if it already exists, old file will be moved to trash.
function uploadFile(localChild, retry = 0) {
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
    data += "Content-Type: " + findTypeFromName(localChild.name) + "\r\n\r\n";

    let uploadPath = "nodes";
    let overwriteOptions = {
        method: "POST",
        filestream: fs.createReadStream(localChild.path),
        footerData: "\r\n----WebKitFormBoundaryE19zNvXGzXaLvS5C--\r\n",
        manualRetry: true
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
    if (!config.silent) {
        console.log("Uploading " + localChild.name + " to " + localChild.parentNode.name);
    }
    //debug("Url: ", uploadPath);
    //debug("Options:", overwriteOptions);
    stats.uploaded += 1;
    let promise = requestContent(uploadPath, data, true, overwriteOptions);
    promise = promise.then(function ignore(result) {
        return result;
    }, function checkRetry(error) {
        debug("Had error", error);
        if (!retry) {
            debug("Will retry upload.");
            return uploadFile(localChild, retry + 1);
        }
    });
    return promise;
}

/********************************************************************************************************
 File Syncing
 ********************************************************************************************************/

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

function filterFile(filename) {
    let ext = path.extname(filename).toLocaleLowerCase();
    return !!config.extensionsWithMime[ext];
}

function checkForDifference(localChild) {
    //try to read md5 hash:
    let promise = readFilePromise(localChild.path + ".md5", "utf8");

    promise = promise.then(function processHash(md5Hash) {
        //check mtimes:
        let ip = statPromise(localChild.path);
        ip = ip.then(function (stat) {
            localChild.mtime = stat.mtime;
            return statPromise(localChild.path + ".md5");
        });
        ip = ip.then(function (stat) {
            if (localChild.mtime > stat.mtime) {
                //debug("MD5 hash of " + localChild.name + " is too old. Creating new one.");
                return createMD5Hash(localChild.path);
            } else {
                //all fine, can use stored hash.
                return md5Hash;
            }
        });
        return ip;
    }, function needToCreateMd5Hash() {
        //debug("No hash for " + localChild.name);
        return createMD5Hash(localChild.path);
    });

    promise = promise.then(function compareHashes(md5Hash) {
        //debug("Node: ", localChild.node);
        if (localChild.node.contentProperties && localChild.node.contentProperties.md5 && localChild.node.contentProperties.md5 === md5Hash) {
            //debug("All fine. Files are identical.");
            stats.alreadyPresent += 1;
            return true;
        } else {
            //debug("Hashes not identical (" + md5Hash + " !=", localChild.node.contentProperties,") or no hash. Reupload file.");
            stats.updated += 1;
            return uploadFile(localChild);
        }
    });

    return promise;
}

function processFile(localChild) {
    if (localChild.inCloud && localChild.node.kind !== "FILE") {
        throw "Error " + localChild.name + " exists as file in " + localChild.parent + ", but remotely is " + localChild.node.kind + ". Please corect manually.";
    }
    stats.filesProcessed += 1;

    if (filterFile(localChild.name)) {
        if (!localChild.inCloud) {
            return uploadFile(localChild);
        } else {
            return checkForDifference(localChild);
        }
    }
    //else
    stats.skipped += 1;
    debug("Skipping " + localChild.name);
}

/********************************************************************************************************
 Folder Syncing
 ********************************************************************************************************/

let syncFolder;
function processFolder(localChild) {
    if (localChild.inCloud && localChild.node.kind !== "FOLDER") {
        throw "Error " + localChild.name + " exists as dir in " + localChild.parent + ", but remotely is " + localChild.node.kind + ". Please corect manually.";
    }

    //debug("Processing " + localChild.name);
    if (!localChild.inCloud) {
        //debug("Folder not yet in cloud, create it,", localChild);
        let promise = createFolder(localChild.parentNode, localChild.name, localChild.path);

        promise = promise.then(function goDeeper(node) {
            localChild.node = node;
            return syncFolder(localChild.node, localChild.path);
        });

        return promise;
    } else {
        return syncFolder(localChild.node, localChild.path);
    }
}

function processLocalChild(localChildren) {
    let localChild = localChildren.shift();
    if (localChild) {
        debug("Processing ", localChild.path);
        let promise = statPromise(localChild.path);
        promise = promise.then(function (stat) {
            localChild.isDir = stat.isDirectory();
            if (localChild.isDir) {
                return processFolder(localChild);
            } else {
                return processFile(localChild);
            }
        });

        promise = promise.then(function processSibling() {
            return processLocalChild(localChildren);
        });

        return promise;
    } else {
        return NodePromise.resolve(true);
    }
}

syncFolder = function(node, folderPath) {
    //get child nodes.
    let promise = listChildren(node);
    let children;
    let localChildren = [];
    stats.foldersProcessed += 1;

    promise = promise.then(function (nodes) {
        children = nodes;
        return readdirPromise(folderPath);
    });

    promise = promise.then(function findDirectories(folderContents) {
        //associate localChildren with cloudChildren:
        folderContents.forEach(function searchChild(name) {
            let localChild = {
                name: name,
                parent: folderPath,
                path: path.resolve(folderPath, name),
                inCloud: false,
                parentNode: node
            };
            children.forEach(function compare(node) {
                if (node.name === name) {
                    localChild.inCloud = true;
                    localChild.node = node;
                }
            });
            localChildren.push(localChild);
        });

        /*let index = 8;
        debug(localChildren[index].name);
        turn processLocalChild(localChildren[index]);*/
        //return NodePromise.all(localChildren.map(processLocalChild));
        return processLocalChild(localChildren);
    });

    return promise;
};

/********************************************************************************************************
 "Main"
 ********************************************************************************************************/

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

promise = promise.then(function startBackup(targetRoot) {
    return syncFolder(targetRoot, config.sourcePath);
});

promise = promise.then(function allgood() {
    if (!config.silent) {
        console.log("All good:", stats);
    }
}, function haderror(err) {
    console.log("Had error:", err);
});
