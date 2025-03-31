// npm install zenrows
const { ZenRows } = require("zenrows");

(async () => {
    const client = new ZenRows("0b0ebc308b1ad4024fad476160014ba04c07b496");
    const url = "https://mercury.com/";

    try {
        const request = await client.get(url, {
			"js_render": "true",
			"premium_proxy": "true"
});
        const data = await request.text();
        console.log(data);
    } catch (error) {
        console.error(error.message);
        if (error.response) {
            console.error(error.response.data);
        }
    }
})();