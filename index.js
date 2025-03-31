const express = require("express");
const { ZenRows } = require("zenrows");
const cheerio = require("cheerio");
const url = require("url");

const app = express();
const PORT = 3000;
const targetUrl = "https://ringcentral.com/";
const client = new ZenRows("0b0ebc308b1ad4024fad476160014ba04c07b496");

app.get("/", async (req, res) => {
    try {
        const request = await client.get(targetUrl, {
            "js_render": "true",
            "premium_proxy": "true"
        });

        let data = await request.text();
        const $ = cheerio.load(data);

        // Convert relative URLs to absolute URLs
        $("a, link").each((_, elem) => {
            const href = $(elem).attr("href");
            if (href && !href.startsWith("http")) {
                $(elem).attr("href", url.resolve(targetUrl, href));
            }
        });

        $("img, script, iframe").each((_, elem) => {
            const src = $(elem).attr("src");
            if (src && !src.startsWith("http")) {
                $(elem).attr("src", url.resolve(targetUrl, src));
            }
        });

        res.send($.html()); // Serve modified HTML
    } catch (error) {
        console.error(error.message);
        res.status(500).send("Error fetching data");
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
