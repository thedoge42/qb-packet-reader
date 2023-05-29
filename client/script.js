// Javascript code common to *all* pages of the site.

// Never use trailing slash, except for the root directory
if (location.pathname.endsWith('/') && location.pathname.length > 1) {
    location.pathname = location.pathname.substring(0, location.pathname.length - 1);
}

// Always use https and www
if (['http://www.qbreader.org', 'http://qbreader.herokuapp.com', 'https://qbreader.herokuapp.com', 'http://qbreader.herokuapp.com', 'https://qbreader-production.herokuapp.com'].includes(location.origin)) {
    location.href = 'https://www.qbreader.org' + location.pathname;
}


if (['http://test.qbreader.org', 'http://qbreader-test.herokuapp.com', 'https://qbreader-test.herokuapp.com'].includes(location.origin)) {
    location.href = 'https://test.qbreader.org' + location.pathname;
}


function isTouchDevice() {
    return true == ('ontouchstart' in window || window.DocumentTouch && document instanceof DocumentTouch);
}


const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
const tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
    if (isTouchDevice()) return;

    return new bootstrap.Tooltip(tooltipTriggerEl);
});


function deleteAccountUsername() {
    sessionStorage.setItem('account-username', JSON.stringify({ username: null, expires: null }));
    document.getElementById('login-link').innerHTML = 'Log in';
    document.getElementById('login-link').href = '/user/login';
}


async function getAccountUsername() {
    let data;
    try {
        data = sessionStorage.getItem('account-username');
        data = data ? JSON.parse(data) : {};
        data = data ? data : {};
    } catch (e) {
        data = {};
        sessionStorage.setItem('account-username', JSON.stringify(data));
    }

    let { username, expires } = data;

    if (username === null) {
        return null;
    } else if (username === undefined) {
        const data = await fetch('/auth/get-username')
            .then(response => {
                if (response.status === 401) {
                    return { username: null, expires: null };
                }
                return response.json();
            });
        username = data.username;
        sessionStorage.setItem('account-username', JSON.stringify(data));
    } else if (expires === null || expires < Date.now()) {
        username = null;
        sessionStorage.setItem('account-username', JSON.stringify({ username: null, expires: null }));
    }

    return username;
}


(async () => {
    const username = await getAccountUsername();
    if (username) {
        document.getElementById('login-link').innerHTML = username;
        document.getElementById('login-link').href = '/user/my-profile';
    }
})();
