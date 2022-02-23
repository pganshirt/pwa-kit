// Just an example of where we can put a client-side only file. Maybe we don't need this util at all
// The problem is there is no clear line in what is universal/server only/client only.
export const getConfig = () => {
    return (
        window.__CONFIG__ ||
        JSON.parse(document.getElementById('mobify-data').innerHTML).__CONFIG__
    )
}