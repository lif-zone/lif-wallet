// wallet_chain.js - SPV header chain store and validation
import * as bitcoin from 'bitcoinjs-lib';
import {buf_from_hex, buf_to_hex, addr_sh, HD_SCAN_GAP,
  hd_addr, xpub_derive_addr, g_settings} from './settings.js';
import {_el} from './electrum.js';
import {hash256_pow, target_buf, target_rcmp, target_from_compact,
  target_to_compact} from './mine.js';
import {hdr_get, hdr_put, hdr_get_tip, hdr_delete_above, tx_get, tx_put,
  sh_history_get, sh_history_put} from './db_util.js';

const HEADERS_FORWARD = 20;
const HEADERS_BACKWARD = 20;
const HEADER_SIZE = 80;
const POW_LIMIT_BITS = 0x1d00ffff;
const RETARGET_INTERVAL = 2016;
const TARGET_TIMESPAN = 14 * 24 * 60 * 60;

// Parse 80-byte raw header buffer into fields
function hdr_parse(raw_hex, height){
  let buf = buf_from_hex(raw_hex);
  if (buf.length!=HEADER_SIZE)
    throw new Error('invalid header size: '+buf.length);
  let version = buf.readInt32LE(0);
  let prevHash = buf_to_hex(Buffer.from(buf.slice(4, 36)).reverse());
  let merkleRoot = buf_to_hex(Buffer.from(buf.slice(36, 68)).reverse());
  let time = buf.readUInt32LE(68);
  let bits = buf.readUInt32LE(72);
  let nonce = buf.readUInt32LE(76);
  return {height, version, prevHash, merkleRoot, time, bits, nonce,
    raw: raw_hex};
}

// Compute block hash from raw header hex using the network's PoW function
function hdr_hash(raw_hex, pow){
  let buf = buf_from_hex(raw_hex);
  let hash = hash256_pow(pow, buf);
  return buf_to_hex(Buffer.from(hash).reverse());
}

// Validate PoW: hash must be <= target derived from bits
function hdr_verify_pow(raw_hex, pow){
  let buf = buf_from_hex(raw_hex);
  let bits = buf.readUInt32LE(72);
  let hash = hash256_pow(pow, buf);
  let target = target_buf(bits);
  return target_rcmp(hash, target)<=0;
}

// Validate bits field against retarget rules.
// prev_hdr: the header at height-1 (required).
// retarget_hdr: the header at the start of the previous period (height - RETARGET_INTERVAL),
//   required only at retarget boundaries (height % RETARGET_INTERVAL == 0).
function hdr_validate_bits(hdr, prev_hdr, retarget_hdr){
  if (hdr.height==0)
    return true;
  if (hdr.height % RETARGET_INTERVAL!=0){
    // Mid-period: bits must equal previous block
    return hdr.bits==prev_hdr.bits;
  }
  // Retarget boundary
  if (!retarget_hdr)
    return false;
  let actual = prev_hdr.time - retarget_hdr.time;
  if (actual < TARGET_TIMESPAN / 4)
    actual = TARGET_TIMESPAN / 4;
  if (actual > TARGET_TIMESPAN * 4)
    actual = TARGET_TIMESPAN * 4;
  let target = target_from_compact(prev_hdr.bits);
  target = target * BigInt(actual) / BigInt(TARGET_TIMESPAN);
  let pow_limit = target_from_compact(POW_LIMIT_BITS);
  if (target > pow_limit)
    target = pow_limit;
  let expected_bits = target_to_compact(target);
  return hdr.bits==expected_bits;
}

// Checkpoints per network symbol: [[height, hash], ...] ascending
// Genesis (height 0) is implicit from network.genesisHash
const CHECKPOINTS = {
  LIF: [
    [500, '00000000762cae595a1dbd8b2d4344a5cb2b867a6eeb9678918f849df67cab11'],
  ],
  tLIF: [],
  BTC: [
    [5000, '000000004d78d2a8a93a1d20a24d721268690bebd2b51f7e80657d57e226eef9'],
    [10000, '0000000099c744455f58e6c6e98b671e1bf7f37346bfd4cf5d0274ad8ee660cb'],
    [15000, '000000005c3548bda7c3d3e2fb2db21f68b87f47dd8b7ed095dfeecee76038b7'],
    [20000, '00000000770ebe897270ca5f6d539d8afb4ea4f4e757761a34ca82e17207d886'],
    [25000, '00000000ae4b125eb183e689b7231eafa8c992d5b8c952d9f3cd30a79a788ddf'],
    [30000, '00000000de1250dc2df5cf4d877e055f338d6ed1ab504d5b71c097cdccd00e13'],
    [35000, '000000008f0cdb273d95e830c726b253b80be537cd21867b0a03ef0a326df91d'],
    [40000, '00000000504d5fa0ad2cb90af16052a4eb2aea70fa1cba653b90a4583c5193e4'],
    [45000, '0000000007758365e4eef39e396f257a3caebb2850906f054066a58ffe657e3b'],
    [50000, '000000001aeae195809d120b5d66a39c83eb48792e068f8ea1fea19d84a4278a'],
    [55000, '000000000a629716ce673212ea154bab57d7d2b62aca42683389dfcdfe747e1a'],
    [60000, '000000000b554c46f8eb7264d7d5e334382c6fc3098dabf734de37962ccd7495'],
    [65000, '0000000006502bbeba998efd13a8dfa7fb6f213da62143f5cddc4b709daa2cc2'],
    [70000, '00000000002b8cd0faa58444df3ba2a22af2b5838c7e4a5b687444f913a575c2'],
    [75000, '00000000000ace2adaabf1baf9dc0ec54434db11e9fd63c1819d8d77df40afda'],
    [80000, '000000000043a8c0fd1d6f726790caa2a406010d19efd2780db27bdbbd93baf6'],
    [85000, '000000000005dcaf122d18052c42041ce2afa1203a0c33b27a4be7a18e3e226f'],
    [90000, '0000000000071694daf735a6b5da101d77a04c7e6008c680e461f0025ba7b7af'],
    [95000, '0000000000074a6f7e2d07cd8e5dd6dc8183993ee3b84666af499bc5b439d21b'],
    [100000, '000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506'],
    [105000, '00000000000291ce28027faea320c8d2b054b2e0fe44a773f3eefb151d6bdc97'],
    [110000, '000000000001bbda3f22ef8e476b470a2d3ae16821c23a6d22db77318d0799a9'],
    [115000, '000000000000e58392f3b59350e72cdaa81655460a0bd5547319522702799993'],
    [120000, '0000000000000e07595fca57b37fea8522e95e0f6891779cfd34d7e537524471'],
    [125000, '00000000000042391c3620056af66ca9ad7cb962424a9b34611915cebb9e1a2a'],
    [130000, '00000000000011906b491883ab0f16f0e690b133ca860b199b775c3cf6581c21'],
    [135000, '00000000000001bf349e3e8195f95a080ea17efe012cf7f512664829f9d3772d'],
    [140000, '000000000000086e28cf4717a80066def0ec26c53d660582bd997221fef297db'],
    [145000, '000000000000087f9aa52a08d8ff065ebe1b6d12f03390fe771faa8720eb96cb'],
    [150000, '0000000000000a3290f20e75860d505ce0e948a1d1d846bec7e39015d242884b'],
    [155000, '0000000000000984d00c9f2d51e6ad2b601b7b1df06deadbf62be24e49b8f486'],
    [160000, '000000000000066c6e629b2fb49c7fcc52b82fe9833f328e0c3943856facf231'],
    [165000, '00000000000008863b4603ab6886773685d259c8bfb90a26243f76adf167ac5a'],
    [170000, '000000000000051f68f43e9d455e72d9c4e4ce52e8a00c5e24c07340632405cb'],
    [175000, '00000000000006b975c097e9a5235de03d9024ddb205fd24dfcd508403fa907c'],
    [180000, '00000000000004ff83b6c10460b239ef4a6aa320e5fffd6c7bcedefa8c78593c'],
    [185000, '00000000000008e4a049f80eb23c83c71f3f2bd34f7a50caf66c17511c40dc13'],
    [190000, '0000000000000708bf3b261ffc963b6a768d915f9cfc9ec0a6c2a09969efad1a'],
    [195000, '0000000000000716889a0c9c7d773f1cfa65cdd6a60a2a9da18b55c9a1f14a33'],
    [200000, '000000000000034a7dedef4a161fa058a2d67a173a90155f3a2fe6fc132e0ebf'],
    [205000, '00000000000002cec464aa21f8aee916b90e6c5c836efa25e4057b74ca6b921c'],
    [210000, '000000000000048b95347e83192f69cf0366076336c639f9b7228e9ba171342e'],
    [215000, '000000000000032f64cb76edfb654062e7b94b152bb6458a59b979fabf99012b'],
    [220000, '000000000000002fdd2c741ed50bc3975a640ca419081711f30f553939641303'],
    [225000, '000000000000013d8781110987bf0e9f230e3cc85127d1ee752d5dd014f8a8e1'],
    [230000, '000000000000012cfb19f5662707816e122ad60dd9b1cd646c6c9899be2c9667'],
    [235000, '0000000000000051324ab4bdc1899c671cd340681ea814b2d4b6e141efec52b0'],
    [240000, '000000000000000e7ad69c72afc00dc4e05fc15ae3061c47d3591d07c09f2928'],
    [245000, '0000000000000023bacb560accb704fcb94665d02f191ce56410b11b93a6636f'],
    [250000, '000000000000003887df1f29024b06fc2200b55f8af8f35453d7be294df2d214'],
    [255000, '000000000000002c4fe8e6977739aaa04694ba5383fbcd730d36fd5b9a83afb7'],
    [260000, '000000000000001fb91fbcebaaba0e2d926f04908d798a8b598c3bd962951080'],
    [265000, '0000000000000000a34b172ea52ed3c4910f5356c0e0724c48b585135794470b'],
    [270000, '0000000000000002a775aec59dc6a9e4bb1c025cf1b8c2195dd9dc3998c827c5'],
    [275000, '00000000000000044750d80a0d3f3e307e54e8802397ae840d91adc28068f5bc'],
    [280000, '0000000000000001c091ada69f444dc0282ecaabe4808ddbb2532e5555db0c03'],
    [285000, '0000000000000000d025f124aa161818f131b56f67d26ea96646ca2ccf671a61'],
    [290000, '0000000000000000fa0b2badd05db0178623ebf8dd081fe7eb874c26e27d0b3b'],
    [295000, '00000000000000004d9b4ef50f0f9d686fd69db2e03af35a100370c64632a983'],
    [300000, '000000000000000082ccf8f1557c5d40b21edabb18d2d691cfbf87118bac7254'],
    [305000, '0000000000000000142bb90561e1a907d500bf534a6727a63a92af5b6abc6160'],
    [310000, '0000000000000000125a28cc9e9209ddb75718f599a8039f6c9e7d9f1fb021e0'],
    [315000, '0000000000000000062ff7f089671d68b37fec1c8a8dca03ba466e39ed95c1be'],
    [320000, '000000000000000015aab005b28a326ade60f07515c33517ea5cb598f28fb7ea'],
    [325000, '00000000000000000409695bce21828b31a7143fa35fcab64670dd337a71425d'],
    [330000, '00000000000000000faabab19f17c0178c754dbed023e6c871dcaf74159c5f02'],
    [335000, '00000000000000000f774c42a2622807ec8beae7f47f4043d93d798b9e7740e6'],
    [340000, '00000000000000000d9b2508615d569e18f00c034d71474fc44a43af8d4a5003'],
    [345000, '0000000000000000172bde54cad0b002c35c89a2a67d82c02bb86ea08c6b54cc'],
    [350000, '0000000000000000053cf64f0400bb38e0c4b3872c38795ddde27acb40a112bb'],
    [355000, '00000000000000000b36c1f926e9f4afeac50a580d220c38aacd0185ffc77126'],
    [360000, '00000000000000000ca6e07cf681390ff888b7f96790286a440da0f2b87c8ea6'],
    [365000, '00000000000000000d2e776c8e4df168e4e78d935197f4b639667c17f84b66da'],
    [370000, '000000000000000002cad3026f68357229dd6eaa6bcef6fe5166e1e53b039b8c'],
    [375000, '000000000000000009733ff8f11fbb9575af7412df3fae97f382376709c965dc'],
    [380000, '00000000000000000b06cee3cee10d2617e2024a996f5c613f7d786b15a571ff'],
    [385000, '00000000000000000b7f6e859cbd68dbc8b309018b0ced9b56b37ac75110f998'],
    [390000, '00000000000000000520000e60b56818523479ada2614806ba17ce0bbe6eaded'],
    [395000, '0000000000000000014b0f613fa97d3f512666a8aa4fd06132ff4fd330a0a664'],
    [400000, '000000000000000004ec466ce4732fe6f1ed1cddc2ed4b328fff5224276e3f6f'],
    [405000, '0000000000000000064964d6c6fc399a7829a6d78fbdc2188686ed221f130c37'],
    [410000, '0000000000000000060d7ea100ecb75c0a4dc482d05ff19ddaa8046b4b80a458'],
    [415000, '000000000000000004379beb807b12d1aab03c02ece6a6d19034cfd19432d444'],
    [420000, '000000000000000002cce816c0ab2c5c269cb081896b7dcb34b8422d6b74ffa1'],
    [425000, '00000000000000000142adfebcb9a0aa75f0c4980dd5c7dd17062bf7de77c16d'],
    [430000, '000000000000000001868b2bb3a285f3cc6b33ea234eb70facf4dcdf22186b87'],
    [435000, '00000000000000000246d7befc7f390da9aabf20d5e0761702c4d8aa2e5a97e4'],
    [440000, '0000000000000000038cc0f7bcdbb451ad34a458e2d535764f835fdeb896f29b'],
    [445000, '000000000000000003287f1b7576b82af3c8927ae8af9a7398bdcbf9af378762'],
    [450000, '0000000000000000014083723ed311a461c648068af8cef8a19dcd620c07a20b'],
    [455000, '00000000000000000254b7be4e1cbee667322f82b72b9c6db2f6d053d2993f88'],
    [460000, '000000000000000000ef751bbce8e744ad303c47ece06c8d863e4d417efc258c'],
    [465000, '0000000000000000011d92a5b831b39d60d92245dc69dfbf0d057b1c3eecd0fc'],
    [470000, '0000000000000000006c539c722e280a0769abd510af0073430159d71e6d7589'],
    [475000, '0000000000000000017c42fd88e78ab02c5f5c684f8344e1f5c9e4cebecde71c'],
    [480000, '000000000000000001024c5d7a766b173fc9dbb1be1a4dc7e039e631fd96a8b1'],
    [485000, '000000000000000000a853011bd61918bc85f26b8b184af1dfa987a3b4470e41'],
    [490000, '000000000000000000de069137b17b8d5a3dfbd5b145b2dcfb203f15d0c4de90'],
    [495000, '0000000000000000004df8b760489cdc4440a7625cd053066e14f03c5b21c97d'],
    [500000, '00000000000000000024fb37364cbf81fd49cc2d51c09c75c35433c3a1945d04'],
    [505000, '00000000000000000025ecc417edf0f1759afa016fedb63062d962cb71a79011'],
    [510000, '000000000000000000152678f83ec36b6951ed3f7e1cc3b04c5828cab8017329'],
    [515000, '0000000000000000003ca88d20895d2535f304cca8afb08e7e5503fcac1da752'],
    [520000, '0000000000000000000d26984c0229c9f6962dc74db0a6d525f2f1640396f69c'],
    [525000, '0000000000000000002ffaa108b110ff7fd64475841b6ab65abd9bb43f8ede1d'],
    [530000, '000000000000000000024e9be1c7b56cab6428f07920f21ad8457221a91371ae'],
    [535000, '0000000000000000002e01e1cc45728dc5672470cfa52710ec74ea26cb3dbede'],
    [540000, '00000000000000000011b3e92e82e0f9939093dccc3614647686c20e5ebe3aa6'],
    [545000, '0000000000000000001f1256c05b66eb061e3fc942521b146dd136a630947b17'],
    [550000, '000000000000000000223b7a2298fb1c6c75fb0efc28a4c56853ff4112ec6bc9'],
    [555000, '00000000000000000012d1c9c6b151ba554364ccf56b9ec7bd0e45dbece8c00c'],
    [560000, '0000000000000000002c7b276daf6efb2b6aa68e2ce3be67ef925b3264ae7122'],
    [565000, '0000000000000000002596e5f8ae63a7816d774885a5cd3bb0dcc168049ce547'],
    [570000, '0000000000000000000822cf76247f1ecec0a82dbecb3b482ec4d2d154e0cd1d'],
    [575000, '00000000000000000007df59824a0c86d1cc21b90eb25259dd2dba5170cea5f5'],
    [580000, '00000000000000000003a93e72663961c2449dd1c92a004d39a6ff0df4ac72a3'],
    [585000, '000000000000000000160896ebed62f575b5af35609bedd96b27003c94f8b475'],
    [590000, '000000000000000000061610767eaa0394cab83c70ff1c09dd6b2a2bdad5d1d1'],
    [595000, '0000000000000000000e7294c83f5351e9c781ad3c318a3fb8c765c9b27588be'],
    [600000, '00000000000000000007316856900e76b4f7a9139cfbfba89842c8d196cd5f91'],
    [605000, '00000000000000000014b7ee206dc82517656d2cc9065d0f02fd75252b1222b6'],
    [610000, '0000000000000000000a6f607f74db48dae0a94022c10354536394c17672b7f7'],
    [615000, '000000000000000000014e2ec690c19097d5e83c2c5e66e1cd83fa85a3af11eb'],
    [620000, '0000000000000000000a9fae27289c097e69ca79f54183cae5b52a5e5a3c4cfa'],
    [625000, '00000000000000000000140a7289f3aada855dfd23b0bb13bb5502b0ca60cdd7'],
    [630000, '000000000000000000024bead8df69990852c202db0e0097c1a12ea637d7e96d'],
    [635000, '0000000000000000000de8fe48015885c04cf07fc40a3e7b4bb3d32cf0b4e488'],
    [640000, '0000000000000000000b3021a283b981dd08f4ccf318b684b214f995d102af43'],
    [645000, '000000000000000000034e21f4bb3e31c4f58856763e774102cf8a478a2daf00'],
    [650000, '0000000000000000000060e32d547b6ae2ded52aadbc6310808e4ae42b08cc6a'],
    [655000, '000000000000000000055882dcf32c5e88f86f474e77a9672d521b63fa6d5e98'],
    [660000, '00000000000000000008eddcaf078f12c69a439dde30dbb5aac3d9d94e9c18f6'],
    [665000, '00000000000000000009e5b1f38cc7438ffef11b51744d919c1151e7431bc72d'],
    [670000, '0000000000000000000411ab5253403532ca82aa6cfe164b4261829155a919f4'],
    [675000, '000000000000000000057b6df3f61f96fbdd4b9c4d76fcb975cb0e8a56577d51'],
    [680000, '000000000000000000076c036ff5119e5a5a74df77abf64203473364509f7732'],
    [685000, '000000000000000000043a68d9e09f48eeb485ac28bde0abb6e0b6cb6e726a21'],
    [690000, '00000000000000000002a23d6df20eecec15b21d32c75833cce28f113de888b7'],
    [695000, '0000000000000000000eb03624788bfae637f5281ef267cc560b527119050c02'],
    [700000, '0000000000000000000590fc0f3eba193a278534220b2b37e9849e1a770ca959'],
    [705000, '000000000000000000091cb395bb506ae7e47ff1446005cbe538aef99c92e725'],
    [710000, '00000000000000000007822e1ddba0bed6a55f0072aa1584c70a2f81c275f587'],
    [715000, '000000000000000000035d66d80d451e69b71ce20c3340b1a954146a2a1344dd'],
    [720000, '00000000000000000000664d48a530c8a9047ae31f6ba81ff5c49c22072d4536'],
    [725000, '00000000000000000005f91517a043a19b452dc4e8cfd872651768dddf7bb8e5'],
    [730000, '0000000000000000000384f28cb3b9cf4377a39cfd6c29ae9466951de38c0529'],
    [735000, '000000000000000000055fc826f66e3b1135096a9d12ff75804815d3d1c72cd8'],
    [740000, '00000000000000000005f28764680afdbd8375216ff8f30b17eeb26bd98aac63'],
    [745000, '000000000000000000025136e9067042f0e054472ca2d2d32ba682d8b2b95153'],
    [750000, '0000000000000000000592a974b1b9f087cb77628bb4a097d5c2c11b3476a58e'],
    [755000, '00000000000000000001cc8f1afc116f2b7f6e64f5cac177be48e5511356a0c6'],
    [760000, '00000000000000000003e1d91b245eb32787afb10afe49b61621375361221c38'],
    [765000, '00000000000000000006e35496e6056700db72df0815e38863cad399df7b5373'],
    [770000, '00000000000000000004ea65f5ffe55bfc0adbc001d3a8e154cc9f19da959ba8'],
    [775000, '0000000000000000000181c97a248752bec586d92dacb226fe5dd93ded6f20d1'],
    [780000, '00000000000000000000b0e5e00e6cd256aa03b58f01454ebe2f2c63c750a421'],
    [785000, '00000000000000000004fec580dc9c4beb7a68890c2282ad818f0e93f2b48bbd'],
    [790000, '00000000000000000001ba9dc00c25c451516958a640a0c4c556a291bbf9d63e'],
    [795000, '00000000000000000002966cb5ba87a61723954e0c67b0eb5e9c878601050fc2'],
    [800000, '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054'],
    [805000, '00000000000000000001e26d96ed68750e91e9a1776a08a176fede4e4654d86b'],
    [810000, '000000000000000000028028ca82b6aa81ce789e4eb9e0321b74c3cbaf405dd1'],
    [815000, '000000000000000000024fdf12257a1d34ed9a56216932d1d132ab23bf44c8fd'],
    [820000, '00000000000000000000ba232574c32b4f0cd023e133c05125310625626d6571'],
    [825000, '00000000000000000001432b1ea8b3b710c3fb7e628d605cf4a42c25d7822431'],
    [830000, '000000000000000000011d55599ed27d7efca05f5849b755319c89eb2cffbc1f'],
    [835000, '000000000000000000021c2f8d6fe88aa56e84c5a84907f46e0fc486f69a2ad1'],
    [840000, '0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5'],
    [845000, '0000000000000000000036b5786fb914287c643a5320de156ff69163229eafa9'],
    [850000, '00000000000000000002a0b5db2a7f8d9087464c2586b546be7bce8eb53b8187'],
    [855000, '0000000000000000000233ea80aa10d38aa4486cd7033fffc2c4df556d0b9138'],
    [860000, '0000000000000000000095dd5c0c8e176a6498eb335c491b96df1a1ae178bfbd'],
    [865000, '000000000000000000018b745cc38c17456b15a0f5a1cec5a4ebe1227bf5467c'],
    [870000, '0000000000000000000152dd9d6059126e4e4dbc2732246bef2b8496ef1d971d'],
    [875000, '00000000000000000002923a7456aa3d4adce139cd16550c3ff36d07cc45d251'],
    [880000, '000000000000000000010b17283c3c400507969a9c2afd1dcf2082ec5cca2880'],
    [885000, '0000000000000000000225aaafa21decf100f8ac065a2a75003d7f2b78d2791b'],
    [890000, '00000000000000000001f49fb5fb37753c06d78f1a811d707aebf6194bb147e5'],
    [895000, '00000000000000000000a00ea70938ea418be5c6e284923835644c3fdc4742a9'],
    [900000, '000000000000000000010538edbfd2d5b809a33dd83f284aeea41c6d0d96968a'],
    [905000, '0000000000000000000090a73b1ea09ad33ac1d9b1ad65ac0aa6c57cb4440058'],
    [910000, '0000000000000000000108970acb9522ffd516eae17acddcb1bd16469194a821'],
    [915000, '000000000000000000010e072de76e1b99adddbe2285ed35095a9efdafa3af2c'],
    [920000, '000000000000000000005e9de5d9e008d923ced659896d9ad012e347882bdc87'],
    [925000, '0000000000000000000067f9f40ca6960173ebee423f6130138762dfc40630bf'],
    [930000, '00000000000000000000df0f80044130bb616de91fb0a1d61f27cdcf20458233'],
    [935000, '0000000000000000000147034958af1652b2b91bba607beacc5e72a56f0fb5ee'],
    [940000, '000000000000000000002afe1e2f7e176047529419532b2a6773c45623a02c12'],
    [945000, '0000000000000000000176404852119a2b1268c41789a2ba78737deacc88fa74'],
    [950000, '000000000000000000010b93c9ea1c29fea277383f0f7d1f26de8b5802e885ff'],
    [955000, '0000000000000000000055222909c19ed96cd371013861337214a3c39a63d828'],
    [960000, '000000000000000000001268aab06132c2dd203f77b6020462cd177942d6959d'],
    [965000, '00000000000000000001595977e6000ce56129f5c9b4073e31ccc30b90b97da9'],
    [970000, '000000000000000000014e6a9bad5f954f266cfb3e8f63f8c2fb7967f29b5a07'],
    [975000, '00000000000000000001be5a79adba906d80e75f34b8fe8b42983ba127faefd0'],
  ],
  tBTC: [],
};

function checkpoint_find(netconf, height){
  let all = [[0, netconf.network.genesisHash]];
  let cps = CHECKPOINTS[netconf.symbol] || [];
  for (let cp of cps){
    if (cp[0]<=height)
      all.push(cp);
  }
  let best = all[0];
  for (let cp of all){
    if (cp[0]>=best[0])
      best = cp;
  }
  return {height: best[0], hash: best[1]};
}

function checkpoint_find_above(netconf, height){
  let cps = CHECKPOINTS[netconf.symbol] || [];
  let best = null;
  for (let cp of cps){
    if (cp[0]>height && (!best || cp[0]<best[0]))
      best = {height: cp[0], hash: cp[1]};
  }
  return best;
}

function checkpoint_latest(netconf){
  let cps = CHECKPOINTS[netconf.symbol] || [];
  if (!cps.length)
    return {height: 0, hash: netconf.network.genesisHash};
  let last = cps[cps.length-1];
  return {height: last[0], hash: last[1]};
}

// Fetch a single header from electrum, validate PoW, return parsed
async function fetch_header(el, pow, height){
  let res = await el.block_headers(height, 1);
  if (res.error || !res.count)
    return {error: 'failed to fetch header at '+height};
  let raw_hex = res.hex;
  let hdr = hdr_parse(raw_hex, height);
  hdr.hash = hdr_hash(raw_hex, pow);
  if (!hdr_verify_pow(raw_hex, pow))
    return {error: 'invalid pow at height '+height};
  return hdr;
}

// Ensure validated difficulty chain from nearest checkpoint to target_height.
// Fetches retarget boundary headers forward, validating and storing each.
async function wc_ensure_difficulty_chain(netconf, target_height){
  if (target_height<=0)
    return {};
  let net = netconf.symbol;
  let pow = netconf.pow;
  let el = _el(netconf);
  let cp = checkpoint_find(netconf, target_height);
  // Ensure checkpoint header is in DB and valid
  let cp_hdr = await hdr_get(net, cp.height);
  if (!cp_hdr){
    let hdr = await fetch_header(el, pow, cp.height);
    if (hdr.error)
      return hdr;
    if (hdr.hash!=cp.hash)
      return {error: 'checkpoint hash mismatch at '+cp.height};
    await hdr_put(net, cp.height, hdr);
    cp_hdr = hdr;
  } else {
    if (!cp_hdr.hash)
      cp_hdr.hash = hdr_hash(cp_hdr.raw, pow);
    if (cp_hdr.hash!=cp.hash)
      return {error: 'cached checkpoint hash mismatch at '+cp.height};
  }
  // If checkpoint is not on a boundary, ensure period-start header exists
  let cp_boundary = Math.floor(cp.height / RETARGET_INTERVAL) * RETARGET_INTERVAL;
  if (cp.height!=cp_boundary && cp_boundary>0){
    let start_hdr = await hdr_get(net, cp_boundary);
    if (!start_hdr){
      start_hdr = await fetch_header(el, pow, cp_boundary);
      if (start_hdr.error)
        return start_hdr;
      if (start_hdr.bits!=cp_hdr.bits)
        return {error: 'bits mismatch at period start '+cp_boundary};
      await hdr_put(net, cp_boundary, start_hdr);
    }
  }
  // Walk forward through retarget boundaries
  let first_boundary = cp_boundary + RETARGET_INTERVAL;
  let last_boundary = Math.floor(target_height / RETARGET_INTERVAL)
    * RETARGET_INTERVAL;
  for (let b=first_boundary; b<=last_boundary; b+=RETARGET_INTERVAL){
    let b_hdr = await hdr_get(net, b);
    if (b_hdr)
      continue;
    // Need period-start, period-end (b-1), and boundary (b)
    let start_hdr = await hdr_get(net, b - RETARGET_INTERVAL);
    if (!start_hdr)
      return {error: 'missing period start at '+(b - RETARGET_INTERVAL)};
    // Fetch period-end header
    let end_hdr = await hdr_get(net, b - 1);
    if (!end_hdr){
      end_hdr = await fetch_header(el, pow, b - 1);
      if (end_hdr.error)
        return end_hdr;
      if (end_hdr.bits!=start_hdr.bits)
        return {error: 'bits mismatch at '+(b - 1)};
      await hdr_put(net, b - 1, end_hdr);
    }
    // Fetch boundary header
    b_hdr = await fetch_header(el, pow, b);
    if (b_hdr.error)
      return b_hdr;
    if (b_hdr.prevHash!=end_hdr.hash)
      return {error: 'prevHash mismatch at '+b};
    if (!hdr_validate_bits(b_hdr, end_hdr, start_hdr))
      return {error: 'invalid retarget at '+b};
    await hdr_put(net, b, b_hdr);
  }
  return {};
}

// State per network
const chain_state = {};

function get_state(netconf){
  let key = netconf.symbol;
  if (!chain_state[key])
    chain_state[key] = {tip: null, netconf};
  return chain_state[key];
}

// Load tip from DB on init
export async function wc_init(netconf){
  let st = get_state(netconf);
  st.tip = await hdr_get_tip(netconf.symbol);
  if (st.tip)
    st.tip.hash = hdr_hash(st.tip.raw, netconf.pow);
  return st;
}

const BATCH_SIZE = 2016;

// Merge overlapping/adjacent [from, to] ranges (sorted by from)
function merge_ranges(ranges){
  if (!ranges.length)
    return [];
  ranges.sort((a, b)=>a[0]-b[0]);
  let merged = [ranges[0]];
  for (let i=1; i<ranges.length; i++){
    let last = merged[merged.length-1];
    if (ranges[i][0]<=last[1]+1)
      last[1] = Math.max(last[1], ranges[i][1]);
    else
      merged.push(ranges[i]);
  }
  return merged;
}

// Detect and handle reorg. Returns {reorg: true, fork_height} or {reorg: false}.
// Only commits if the new chain is longer and fully validated.
async function wc_check_reorg(netconf, chain_height){
  let net = netconf.symbol;
  let pow = netconf.pow;
  let el = _el(netconf);
  let st = get_state(netconf);
  if (!st.tip || !chain_height)
    return {reorg: false};
  let local_tip = st.tip.height;
  if (chain_height<=local_tip)
    return {reorg: false};
  // Check if new tip connects to our chain
  let new_tip_res = await el.block_headers(chain_height, 1);
  if (new_tip_res.error || !new_tip_res.count)
    return {reorg: false};
  let new_tip = hdr_parse(new_tip_res.hex, chain_height);
  // If we have the header at chain_height-1 and it matches, no reorg
  let prev_local = await hdr_get(net, chain_height-1);
  if (prev_local){
    let prev_hash = hdr_hash(prev_local.raw, pow);
    if (new_tip.prevHash==prev_hash)
      return {reorg: false};
  } else if (chain_height>local_tip+1){
    // Gap between our tip and server tip — not necessarily a reorg,
    // just missing headers. wc_sync_headers will fill the gap.
    return {reorg: false};
  }
  // prevHash mismatch — potential reorg. Find fork point by walking back.
  console.log('wc_check_reorg: potential reorg detected at height',
    chain_height, 'local tip', local_tip);
  // Fetch new chain headers from server, walking back to find fork point
  let new_headers = []; // [{height, hdr, raw_hex}] in descending order
  let h = chain_height;
  while (h>0){
    let res = await el.block_headers(h, 1);
    if (res.error || !res.count){
      console.warn('wc_check_reorg: failed to fetch header at', h);
      return {reorg: false};
    }
    let raw_hex = res.hex;
    let hdr = hdr_parse(raw_hex, h);
    hdr.hash = hdr_hash(raw_hex, pow);
    if (!hdr_verify_pow(raw_hex, pow)){
      console.warn('wc_check_reorg: invalid PoW at height', h);
      return {reorg: false};
    }
    new_headers.push({height: h, hdr, raw_hex});
    // Check if this header's prevHash matches our stored header at h-1
    let local_prev = await hdr_get(net, h-1);
    if (local_prev){
      let local_prev_hash = hdr_hash(local_prev.raw, pow);
      if (hdr.prevHash==local_prev_hash){
        // Found fork point: h-1
        break;
      }
    }
    if (h<=1)
      break;
    h--;
  }
  if (!new_headers.length)
    return {reorg: false};
  let fork_height = new_headers[new_headers.length-1].height-1;
  console.log('wc_check_reorg: fork point at height', fork_height);
  // Reject reorgs below the latest checkpoint
  let latest_cp = checkpoint_latest(netconf);
  if (fork_height < latest_cp.height){
    console.warn('wc_check_reorg: rejecting reorg below checkpoint',
      latest_cp.height, 'fork at', fork_height);
    return {reorg: false};
  }
  // Validate the new chain links and bits (ascending order)
  new_headers.reverse();
  for (let i=0; i<new_headers.length; i++){
    let {height, hdr} = new_headers[i];
    if (i>0){
      let prev_hash = new_headers[i-1].hdr.hash;
      if (hdr.prevHash!=prev_hash){
        console.warn('wc_check_reorg: new chain broken at height', height);
        return {reorg: false};
      }
    }
    // Validate bits
    let prev_hdr = i>0 ? new_headers[i-1].hdr
      : await hdr_get(net, height-1);
    if (prev_hdr){
      let retarget_hdr = null;
      if (height % RETARGET_INTERVAL==0)
        retarget_hdr = await hdr_get(net, height - RETARGET_INTERVAL);
      if (!hdr_validate_bits(hdr, prev_hdr, retarget_hdr)){
        console.warn('wc_check_reorg: invalid bits at height', height);
        return {reorg: false};
      }
    }
  }
  // New chain is valid and longer — commit reorg
  console.log('wc_check_reorg: committing reorg, deleting headers above',
    fork_height);
  let deleted = await hdr_delete_above(net, fork_height);
  console.log('wc_check_reorg: deleted', deleted, 'old headers');
  // Write new headers to DB
  for (let {height, hdr} of new_headers)
    await hdr_put(net, height, hdr);
  console.log('wc_check_reorg: wrote', new_headers.length, 'new headers');
  // Update tip
  st.tip = new_headers[new_headers.length-1].hdr;
  // Invalidate TXes confirmed above fork point — they need re-verification
  // The caller's wc_store_tx will re-fetch merkle proofs against new headers
  return {reorg: true, fork_height};
}

// Sync headers around TX heights. Only fetches what's missing from DB.
// First ensures difficulty chain is validated from checkpoint, then fetches
// contiguous ranges and validates each header against the difficulty chain.
export async function wc_sync_headers(netconf, tx_heights, chain_height){
  let net = netconf.symbol;
  let el = _el(netconf);
  if (!tx_heights?.length)
    return {height: chain_height, count: 0};
  // Compute needed ranges from TX heights
  let full_spv = !!g_settings.ls?.full_spv;
  let ranges = tx_heights.map(h=>{
    let from, to;
    if (full_spv){
      from = checkpoint_find(netconf, h).height;
      let cp_above = checkpoint_find_above(netconf, h);
      to = cp_above
        ? Math.min(chain_height, cp_above.height)
        : Math.min(chain_height, h+HEADERS_FORWARD);
    } else {
      from = Math.max(0, h-HEADERS_BACKWARD);
      to = Math.min(chain_height, h+HEADERS_FORWARD);
    }
    return [from, to];
  });
  ranges = merge_ranges(ranges);
  // Ensure difficulty chain covers all needed heights
  let max_height = ranges.length
    ? ranges[ranges.length-1][1] : 0;
  let dc_res = await wc_ensure_difficulty_chain(netconf, max_height);
  if (dc_res.error)
    return dc_res;
  // Remove heights we already have
  let missing = [];
  for (let [from, to] of ranges){
    let run_start = null;
    for (let h=from; h<=to; h++){
      let existing = await hdr_get(net, h);
      if (!existing){
        if (run_start==null)
          run_start = h;
      } else {
        if (run_start!=null){
          missing.push([run_start, h-1]);
          run_start = null;
        }
      }
    }
    if (run_start!=null)
      missing.push([run_start, to]);
  }
  if (!missing.length)
    return {height: chain_height, count: 0};
  // Fetch missing ranges in batches
  let pow = netconf.pow;
  let latest_cp = checkpoint_latest(netconf);
  let max_ts = Math.floor(Date.now()/1000) + 24*60*60;
  let total = 0;
  for (let [from, to] of missing){
    let start = from;
    while (start<=to){
      let want = Math.min(BATCH_SIZE, to-start+1);
      let res = await el.block_headers(start, want);
      if (res.error)
        return {error: 'block_headers '+start+': '+res.error};
      let {hex, count} = res;
      if (!count)
        break;
      for (let i=0; i<count; i++){
        let raw_hex = hex.slice(i*HEADER_SIZE*2, (i+1)*HEADER_SIZE*2);
        let h = start+i;
        let hdr = hdr_parse(raw_hex, h);
        hdr.hash = hdr_hash(raw_hex, pow);
        if (!hdr_verify_pow(raw_hex, pow))
          return {error: 'invalid pow at height '+h};
        // Reject future timestamps beyond last checkpoint
        if (h>latest_cp.height && hdr.time>max_ts)
          return {error: 'header timestamp too far in future at '+h};
        // Validate prevHash against previous header if we have it
        let prev = await hdr_get(net, h-1);
        if (prev){
          let prev_hash = hdr_hash(prev.raw, pow);
          if (hdr.prevHash!=prev_hash)
            return {error: 'prevHash mismatch at height '+h};
        }
        // Validate bits against difficulty chain
        let period_start = Math.floor(h / RETARGET_INTERVAL)
          * RETARGET_INTERVAL;
        let expected_hdr = await hdr_get(net, period_start);
        if (expected_hdr){
          if (hdr.bits!=expected_hdr.bits)
            return {error: 'bits mismatch at height '+h};
        }
        await hdr_put(net, h, hdr);
        total++;
      }
      start += count;
    }
  }
  if (total)
    console.log('wc_sync_headers: synced '+total+' headers for '+net);
  return {height: chain_height, count: total};
}

// Get a stored header by height
export async function wc_get_header(netconf, height){
  return await hdr_get(netconf.symbol, height);
}

// Step 2: TX store with merkle proofs

// Compute merkle root from txid + proof path + position
// Merkle trees always use double-SHA256 (like bitcoin), not the PoW hash
function merkle_root_from_proof(txid, merkle, pos){
  let hash = buf_from_hex(txid).reverse();
  for (let sibling of merkle){
    let s = buf_from_hex(sibling).reverse();
    hash = hash256_pow('sha256', Buffer.concat(pos&1 ? [s, hash] : [hash, s]));
    pos >>= 1;
  }
  return buf_to_hex(Buffer.from(hash).reverse());
}

// Fetch TX + merkle proof + verbose from electrum, store all. Cache-first.
// Mempool TXes (height<=0) stored without merkle proof.
// If a cached mempool TX is now confirmed, re-fetch with merkle proof.
export async function wc_store_tx(netconf, txid, height, force){
  let existing = await tx_get(txid);
  if (!force && existing && (existing.height>0 || height<=0)){
    // Re-verify merkle proof if header now available
    if (existing.height>0 && !existing.verified && existing.merkle){
      let hdr = await hdr_get(netconf.symbol, existing.height);
      if (hdr){
        let root = existing.merkle_root
          || merkle_root_from_proof(txid, existing.merkle, existing.pos);
        if (hdr.merkleRoot!=root)
          return {error: 'invalid merkle proof for cached tx '+txid};
        existing.verified = true;
        existing.merkle_root = root;
        await tx_put(txid, existing);
      }
    }
    return existing;
  }
  let el = _el(netconf);
  // Mempool: no merkle proof available
  if (height<=0)
  {
    let [raw, verbose] = await Promise.all([
      el.tx_get(txid, false),
      el.tx_get(txid, true),
    ]);
    if (raw?.error)
      return {error: 'tx_get '+txid+': '+raw.error};
    let tx = bitcoin.Transaction.fromHex(raw);
    if (tx.getId()!=txid)
    {
      console.warn('wc_store_tx: TX txid mismatch', txid, tx.getId());
      return {error: 'txid mismatch'};
    }
    let entry = {txid, raw, verbose, height, verified: false};
    await tx_put(txid, entry);
    return entry;
  }
  // Confirmed: fetch with merkle proof
  let [raw, verbose, merkle_res] = await Promise.all([
    el.tx_get(txid, false),
    el.tx_get(txid, true),
    el.tx_get_merkle(txid, height),
  ]);
  if (raw?.error)
    return {error: 'tx_get '+txid+': '+raw.error};
  if (merkle_res?.error)
    return {error: 'tx_get_merkle '+txid+': '+merkle_res.error};
  let tx = bitcoin.Transaction.fromHex(raw);
  if (tx.getId()!=txid)
  {
    console.warn('wc_store_tx: TX txid mismatch', txid, tx.getId());
    return {error: 'txid mismatch'};
  }
  let {merkle, pos} = merkle_res;
  let computed_root = merkle_root_from_proof(txid, merkle, pos);
  let hdr = await hdr_get(netconf.symbol, height);
  if (hdr && hdr.merkleRoot!=computed_root)
  {
    console.warn('wc_store_tx: invalid merkle proof from electrum server',
      txid, 'height', height, 'expected', hdr.merkleRoot, 'got',
      computed_root);
    return {error: 'invalid merkle proof'};
  }
  let verified = !!(hdr && hdr.merkleRoot==computed_root);
  let entry = {txid, raw, verbose, height, merkle, pos, merkle_root:
    computed_root, verified};
  await tx_put(txid, entry);
  return entry;
}

// Get verbose TX — local first, fetch+store if missing
export async function wc_tx_get_verbose(netconf, txid){
  let entry = await tx_get(txid);
  if (entry?.verbose)
    return entry.verbose;
  let el = _el(netconf);
  let verbose = await el.tx_get(txid, true);
  if (verbose?.error)
    return verbose;
  if (entry)
    entry.verbose = verbose;
  else
    entry = {txid, verbose};
  await tx_put(txid, entry);
  return verbose;
}

// Verify a stored TX against its header (e.g. after syncing new headers)
export async function wc_verify_tx(netconf, txid){
  let entry = await tx_get(txid);
  if (!entry)
    return {error: 'tx not found'};
  let hdr = await hdr_get(netconf.symbol, entry.height);
  if (!hdr)
    return {error: 'header not found at height '+entry.height};
  let root = entry.merkle_root
    || merkle_root_from_proof(txid, entry.merkle, entry.pos);
  entry.merkle_root = root;
  entry.verified = hdr.merkleRoot==root;
  await tx_put(txid, entry);
  return entry;
}

// Get stored TX
export async function wc_get_tx(txid){
  return await tx_get(txid);
}

// Step 5: wc versions of wallet_db functions

// Fetch sh history from electrum if stale (checked_height < chain_height)
// refresh=true ignores checked_height, always re-queries
async function sh_history_fetch(netconf, sh, chain_height, refresh){
  let cached = await sh_history_get(sh);
  if (cached && !refresh && cached.checked_height>=chain_height)
    return cached.entries;
  let el = _el(netconf);
  let history = await el.sh_get_history(sh);
  if (history?.error)
    return cached?.entries || [];
  await sh_history_put(sh, {entries: history, checked_height: chain_height});
  return history;
}

// HD scan — cache-first, fetches from electrum only what's missing
// refresh=true: re-query all address histories ignoring cached height
// Returns used addresses+histories only. Does NOT fetch TXes (caller does
// that after syncing headers so merkle proofs can be verified).
export async function wc_hd_scan(netconf, root, accountPath, chain,
  chain_height, refresh)
{
  let network = netconf.network;
  let used = [];
  let lastUsed = -1;
  let start = 0;
  while (true){
    let entries = Array.from({length: HD_SCAN_GAP},
      (_, i)=>hd_addr(network, root, accountPath, chain, start+i));
    let hists = await Promise.all(entries.map(e=>
      sh_history_fetch(netconf, addr_sh(e.address, network),
        chain_height, refresh)));
    let anyUsed = false;
    for (let i=0; i<HD_SCAN_GAP; i++){
      let hist = hists[i];
      if (!hist?.length)
        continue;
      used.push({...entries[i], hist});
      lastUsed = entries[i].index;
      anyUsed = true;
    }
    if (!anyUsed)
      break;
    start += HD_SCAN_GAP;
  }
  return {used, nextIndex: lastUsed+1};
}

// HD scan using public-only node (for zpub watch-only wallets)
export async function wc_zpub_scan(netconf, node, chain, chain_height, refresh){
  let network = netconf.network;
  let used = [];
  let lastUsed = -1;
  let start = 0;
  while (true){
    let entries = Array.from({length: HD_SCAN_GAP},
      (_, i)=>xpub_derive_addr(network, node, chain, start+i));
    let hists = await Promise.all(entries.map(e=>
      sh_history_fetch(netconf, addr_sh(e.address, network),
        chain_height, refresh)));
    let anyUsed = false;
    for (let i=0; i<HD_SCAN_GAP; i++){
      let hist = hists[i];
      if (!hist?.length)
        continue;
      used.push({...entries[i], hist});
      lastUsed = entries[i].index;
      anyUsed = true;
    }
    if (!anyUsed)
      break;
    start += HD_SCAN_GAP;
  }
  return {used, nextIndex: lastUsed+1};
}

// Scan explicit addresses (for address watch-only wallets)
export async function wc_addr_scan(netconf, addresses, chain_height, refresh){
  let network = netconf.network;
  let used = [];
  let hists = await Promise.all(addresses.map(addr=>
    sh_history_fetch(netconf, addr_sh(addr, network), chain_height, refresh)));
  for (let i=0; i<addresses.length; i++){
    let hist = hists[i];
    used.push({address: addresses[i], chain: 0, index: i, hist: hist || []});
  }
  return {used, nextIndex: addresses.length};
}

// Step 3: UTXO + balance from local DB

// Parse raw tx hex, extract output addresses
function tx_parse_outputs(raw_hex, network){
  let tx = bitcoin.Transaction.fromHex(raw_hex);
  let outputs = [];
  for (let i=0; i<tx.outs.length; i++){
    let addr;
    try {
      addr = bitcoin.address.fromOutputScript(tx.outs[i].script, network);
    } catch(e){}
    outputs.push({index: i, value: Number(tx.outs[i].value), address: addr});
  }
  return {txid: tx.getId(), outputs, inputs: tx.ins.map(inp=>({
    txid: Buffer.from(inp.hash).reverse().toString('hex'),
    vout: inp.index,
  }))};
}

function sh_entries(cached){
  if (!cached)
    return [];
  return cached.entries || cached;
}

// Compute balance from locally stored TXs for a set of addresses
export async function wc_get_balance(netconf, addrs){
  let network = netconf.network;
  let addr_set = new Set(addrs.map(a=>a.address));
  let spent = new Set();
  let confirmed = 0;
  let unconfirmed = 0;
  let full_spv = !!g_settings.ls?.full_spv;
  // Collect all TXs from scripthash histories
  let tx_entries = [];
  for (let a of addrs){
    let sh = addr_sh(a.address, network);
    let hist = sh_entries(await sh_history_get(sh));
    if (!hist.length)
      continue;
    for (let h of hist){
      let entry = await tx_get(h.tx_hash);
      if (!entry)
        continue;
      // Full SPV: skip unverified confirmed TXs
      if (full_spv && h.height>0 && !entry.verified)
        continue;
      tx_entries.push({entry, height: h.height});
    }
  }
  // Mark spent outputs
  for (let {entry} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let inp of parsed.inputs)
      spent.add(inp.txid+':'+inp.vout);
  }
  // Sum unspent outputs belonging to our addresses
  for (let {entry, height} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let out of parsed.outputs){
      if (!addr_set.has(out.address))
        continue;
      if (spent.has(entry.txid+':'+out.index))
        continue;
      if (height>0)
        confirmed += out.value;
      else
        unconfirmed += out.value;
    }
  }
  return {confirmed, unconfirmed};
}

// List unspent outputs from locally stored TXs for a set of addresses
export async function wc_listunspent(netconf, addrs){
  let network = netconf.network;
  let addr_set = new Set(addrs.map(a=>a.address));
  let full_spv = !!g_settings.ls?.full_spv;
  let spent = new Set();
  let tx_entries = [];
  for (let a of addrs){
    let sh = addr_sh(a.address, network);
    let hist = sh_entries(await sh_history_get(sh));
    if (!hist.length)
      continue;
    for (let h of hist){
      let entry = await tx_get(h.tx_hash);
      if (!entry)
        continue;
      if (full_spv && h.height>0 && !entry.verified)
        continue;
      tx_entries.push({entry, height: h.height});
    }
  }
  for (let {entry} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let inp of parsed.inputs)
      spent.add(inp.txid+':'+inp.vout);
  }
  let unspent = [];
  for (let {entry, height} of tx_entries){
    let parsed = tx_parse_outputs(entry.raw, network);
    for (let out of parsed.outputs){
      if (!addr_set.has(out.address))
        continue;
      if (spent.has(entry.txid+':'+out.index))
        continue;
      let a = addrs.find(a=>a.address==out.address);
      unspent.push({tx_hash: entry.txid, tx_pos: out.index, value: out.value,
        height, address: out.address, chain: a?.chain, index: a?.index});
    }
  }
  return unspent;
}

export {HEADERS_FORWARD, HEADERS_BACKWARD, wc_check_reorg};
