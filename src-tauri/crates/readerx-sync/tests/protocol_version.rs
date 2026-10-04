//! 旧服务端无论接受还是拒绝，都应在鉴权前识别版本不兼容。
use std::io::BufReader;
use std::net::TcpListener;
use std::time::Duration;
use readerx_sync::net::client::ClientIdentity;
use readerx_sync::net::frame::{read_message, write_message};
use readerx_sync::net::TcpTransport;
use readerx_sync::proto::{Request, Response, MAX_HANDSHAKE_BYTES};
use readerx_sync::{VersionVector, PROTOCOL_VERSION};

#[test]
fn client_rejects_old_protocol_before_auth() {
    for ok in [false, true] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let hello: Request = read_message(&mut reader, MAX_HANDSHAKE_BYTES).unwrap().unwrap();
            assert!(matches!(hello, Request::Hello { protocol, .. } if protocol == PROTOCOL_VERSION));
            write_message(&mut stream, &Response::Hello {
                ok, protocol: "readerx-sync/1".into(), group: "group".into(),
                device: "old-server".into(), name: "old".into(), nonce: "nonce".into(),
                message: None, code: None, content: true, asset_chunks: false, chapter_chunks: false,
            }, MAX_HANDSHAKE_BYTES).unwrap();
            assert!(read_message::<_, Request>(&mut reader, MAX_HANDSHAKE_BYTES).unwrap().is_none());
        });
        let identity = ClientIdentity {
            group: "group", device: "client", name: "new", knowledge: VersionVector::default(),
            listen_port: 0, content: true,
        };
        let error = TcpTransport::connect(&addr.to_string(), b"secret", &identity, Duration::from_secs(5))
            .err().expect("不兼容版本必须被拒绝");
        assert_eq!(error.code(), "protocol_mismatch");
        server.join().unwrap();
    }
}

#[test]
fn server_rejects_old_protocol_before_registering_peer() {
    use readerx_sync::net::{lock_engine, shared, PeerServer, ServerOptions};
    use readerx_sync::{EngineOptions, SyncEngine};
    let root = std::env::temp_dir().join(format!("readerx-sync-protocol-{}", readerx_sync::new_id()));
    let engine = shared(SyncEngine::open(&root, EngineOptions::new("server")).unwrap());
    let options = ServerOptions::from_engine(&lock_engine(&engine)).unwrap()
        .with_bind(([127, 0, 0, 1], 0).into());
    let group = lock_engine(&engine).group_id().to_string();
    let server = PeerServer::start(engine.clone(), options).unwrap();
    let mut stream = std::net::TcpStream::connect(server.local_addr()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write_message(&mut stream, &Request::Hello {
        protocol: "readerx-sync/1".into(), group, device: "old-client".into(),
        name: "old".into(), knowledge: VersionVector::default(), nonce: "nonce".into(),
        port: 0, content: true, asset_chunks: false, chapter_chunks: false,
    }, MAX_HANDSHAKE_BYTES).unwrap();
    let mut reader = BufReader::new(stream);
    let response: Response = read_message(&mut reader, MAX_HANDSHAKE_BYTES).unwrap().unwrap();
    assert!(matches!(response, Response::Hello { ok: false, protocol, code: Some(code), .. }
        if protocol == PROTOCOL_VERSION && code == "protocol_mismatch"));
    assert!(read_message::<_, Response>(&mut reader, MAX_HANDSHAKE_BYTES).unwrap().is_none());
    assert!(lock_engine(&engine).peers().is_empty());
    drop(reader);
    drop(server);
    drop(engine);
    std::fs::remove_dir_all(root).unwrap();
}
