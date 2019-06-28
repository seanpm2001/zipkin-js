const {expect} = require('chai');
const {
  maybeMiddleware,
  newSpanRecorder,
  expectB3Headers,
  expectSpan
} = require('../../../test/testFixture');
const {ExplicitContext, Tracer} = require('zipkin');

const axios = require('axios');
const wrapAxios = require('../src/index');

// NOTE: axiosjs raises an error on non 2xx status instead of passing to the normal callback.
describe('axios instrumentation - integration test', () => {
  const serviceName = 'weather-app';
  const remoteServiceName = 'weather-api';

  let server;
  let baseURL = ''; // default to relative path, for browser-based tests

  before((done) => {
    const middleware = maybeMiddleware();
    if (middleware !== null) {
      server = middleware.listen(0, () => {
        baseURL = `http://127.0.0.1:${server.address().port}`;
        done();
      });
    } else { // Inside a browser
      done();
    }
  });

  after(() => {
    if (server) server.close();
  });

  let spans;
  let tracer;

  beforeEach(() => {
    spans = [];
    tracer = new Tracer({ctxImpl: new ExplicitContext(), recorder: newSpanRecorder(spans)});
  });

  function popSpan() {
    expect(spans).to.not.be.empty; // eslint-disable-line no-unused-expressions
    return spans.pop();
  }

  function getClient() {
    const instance = axios.create({
      timeout: 300 // this avoids flakes in CI
    });

    return wrapAxios(instance, {tracer, serviceName, remoteServiceName});
  }

  function url(path) {
    return `${baseURL}${path}?index=10&count=300`;
  }

  function successSpan(path) {
    return ({
      name: 'get',
      kind: 'CLIENT',
      localEndpoint: {serviceName},
      remoteEndpoint: {serviceName: remoteServiceName},
      tags: {
        'http.path': path,
        'http.status_code': '202'
      }
    });
  }

  it('should add headers to requests', () => {
    const path = '/weather/wuhan';
    return getClient().get(url(path))
      .then(response => expectB3Headers(popSpan(), response.data));
  });

  it('should not interfere with errors that precede a call', done => {
    // Here we are passing a function instead of the value of it. This ensures our error callback
    // doesn't make assumptions about a span in progress: there won't be if there was a config error
    getClient()(url)
      .then(response => {
        done(new Error(`expected an invalid url parameter to error. status: ${response.status}`));
      })
      .catch(error => {
        const message = error.message;
        const expected = [
          'must be of type string', // node
          'must be a string' // browser
        ];
        if (message.indexOf(expected[0]) !== -1 || message.indexOf(expected[1]) !== -1) {
          done();
        } else {
          done(new Error(`expected error message to match [${expected.toString()}]: ${message}`));
        }
      });
  });

  it('should support get request', () => {
    const path = '/weather/wuhan';
    return getClient().get(url(path))
      .then(() => expectSpan(popSpan(), successSpan(path)));
  });

  it('should support options request', () => {
    const path = '/weather/wuhan';
    return getClient()({url: url(path)})
      .then(() => expectSpan(popSpan(), successSpan(path)));
  });

  it('should report 404 in tags', done => {
    const path = '/pathno';
    getClient().get(url(path))
      .then(response => {
        done(new Error(`expected status 404 response to error. status: ${response.status}`));
      })
      .catch(() => {
        expectSpan(popSpan(), {
          name: 'get',
          kind: 'CLIENT',
          localEndpoint: {serviceName},
          remoteEndpoint: {serviceName: remoteServiceName},
          tags: {
            'http.path': path,
            'http.status_code': '404',
            error: '404'
          }
        });
        done();
      });
  });

  it('should report 400 in tags', done => {
    const path = '/weather/securedTown';
    getClient().get(url(path))
      .then(response => {
        done(new Error(`expected status 400 response to error. status: ${response.status}`));
      })
      .catch(() => {
        expectSpan(popSpan(), {
          name: 'get',
          kind: 'CLIENT',
          localEndpoint: {serviceName},
          remoteEndpoint: {serviceName: remoteServiceName},
          tags: {
            'http.path': path,
            'http.status_code': '400',
            error: '400'
          }
        });
        done();
      });
  });

  it('should report 500 in tags', done => {
    const path = '/weather/bagCity';
    getClient().get(url(path))
      .then(response => {
        done(new Error(`expected status 500 response to error. status: ${response.status}`));
      })
      .catch(() => {
        expectSpan(popSpan(), {
          name: 'get',
          kind: 'CLIENT',
          localEndpoint: {serviceName},
          remoteEndpoint: {serviceName: remoteServiceName},
          tags: {
            'http.path': path,
            'http.status_code': '500',
            error: '500'
          }
        });
        done();
      });
  });

  it('should report when endpoint doesnt exist in tags', done => {
    const path = '/badHost';
    const badUrl = `http://localhost:12345${path}`;
    getClient().get(badUrl)
      .then(response => {
        done(new Error(`expected an invalid host to error. status: ${response.status}`));
      })
      .catch(error => {
        expectSpan(popSpan(), {
          name: 'get',
          kind: 'CLIENT',
          localEndpoint: {serviceName},
          remoteEndpoint: {serviceName: remoteServiceName},
          tags: {
            'http.path': path,
            error: error.toString()
          }
        });
        done();
      });
  });

  it('should support nested get requests', () => {
    const client = getClient();

    const beijing = '/weather/beijing';
    const wuhan = '/weather/wuhan';

    const getBeijingWeather = client.get(url(beijing));
    const getWuhanWeather = client.get(url(wuhan));

    return getBeijingWeather.then(() => {
      getWuhanWeather.then(() => {
        // since these are sequential, we should have an expected order
        expectSpan(popSpan(), successSpan(wuhan));
        expectSpan(popSpan(), successSpan(beijing));
      });
    });
  });

  it('should support parallel get requests', () => {
    const client = getClient();

    const beijing = '/weather/beijing';
    const wuhan = '/weather/wuhan';

    const getBeijingWeather = client.get(url(beijing));
    const getWuhanWeather = client.get(url(wuhan));

    return Promise.all([getBeijingWeather, getWuhanWeather]).then(() => {
      // since these are parallel, we have an unexpected order
      const firstPath = spans[0].tags['http.path'] === wuhan ? beijing : wuhan;
      const secondPath = firstPath === wuhan ? beijing : wuhan;
      expectSpan(popSpan(), successSpan(firstPath));
      expectSpan(popSpan(), successSpan(secondPath));
    });
  });
});
