# AmazonImageSync

A tool to sync image files to Amazon Drive.

Currently Amazon does not accept new apps to use their API, so we have to "use" a foreign Client Secret. One example is https://drivesink.appspot.com.
This needs an auth.json, which you can generate using https://drivesink.appspot.com/config and then copy the stuff in the grey "Here is your configuration" field and store it in
"auth.json" in the path of this node script.

