// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A test token for the example paid tools. It has the shape token_risk_check looks for: an owner, pause functions, and
/// a VAULT_ROLE whose holders can mint and burn any holder's balance, with a DEFAULT_ADMIN_ROLE that can grant that role.
/// Test use only. Never deployed anywhere.
contract RoleToken {
    string public name = "Role Token";
    string public symbol = "RLT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    bool public paused;

    bytes32 public constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(bytes32 => bytes32) private _roleAdmin;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address admin, address owner_) {
        _roles[DEFAULT_ADMIN_ROLE][admin] = true;
        emit RoleGranted(DEFAULT_ADMIN_ROLE, admin, msg.sender);
        owner = owner_;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function getRoleAdmin(bytes32 role) external view returns (bytes32) {
        return _roleAdmin[role];
    }

    function grantRole(bytes32 role, address account) external {
        require(_roles[_roleAdmin[role]][msg.sender], "not the role admin");
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) external {
        require(_roles[_roleAdmin[role]][msg.sender], "not the role admin");
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function mint(address to, uint256 amount) external {
        require(_roles[VAULT_ROLE][msg.sender], "no vault role");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(_roles[VAULT_ROLE][msg.sender], "no vault role");
        require(balanceOf[from] >= amount, "balance too low");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function pause() external {
        require(msg.sender == owner, "not the owner");
        paused = true;
    }

    function unpause() external {
        require(msg.sender == owner, "not the owner");
        paused = false;
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "not the owner");
        owner = next;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
