// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A token with a chosen number of decimals, for the DEX quote tests. Test use only.
contract MockToken {
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(string memory symbol_, uint8 decimals_) {
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }
}

/// A token with no admin functions at all: reads, a transfer, and a fixed supply minted to the deployer. Test use only.
contract PlainToken {
    string public symbol = "PLN";
    uint8 public constant decimals = 6;
    uint256 public immutable totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A pool whose reserves the test sets directly, in the Uniswap V2 layout (token0, token1, getReserves).
contract MockPair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setReserves(address tokenA, uint112 amountA, uint112 amountB) external {
        if (tokenA == token0) {
            reserve0 = amountA;
            reserve1 = amountB;
        } else {
            reserve1 = amountA;
            reserve0 = amountB;
        }
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }
}

contract MockFactory {
    mapping(address => mapping(address => address)) public getPair;

    function setPair(address a, address b, address pair) external {
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

/// getAmountsOut with a configurable fee, so a test can make the router disagree with the standard pool formula.
contract MockRouter {
    address public immutable factory;
    address public immutable WETH;
    uint256 public immutable feeNumerator;

    constructor(address factory_, address weth_, uint256 feeNumerator_) {
        factory = factory_;
        WETH = weth_;
        feeNumerator = feeNumerator_;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            MockPair pair = MockPair(MockFactory(factory).getPair(path[i], path[i + 1]));
            (uint112 r0, uint112 r1,) = pair.getReserves();
            (uint256 reserveIn, uint256 reserveOut) = path[i] == pair.token0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 withFee = amounts[i] * feeNumerator;
            amounts[i + 1] = (withFee * reserveOut) / (reserveIn * 1000 + withFee);
        }
    }
}
